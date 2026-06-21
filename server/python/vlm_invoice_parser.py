"""
vlm_invoice_parser.py
Place in: server/python/vlm_invoice_parser.py

Handles invoice formats:
  - Service invoices    (Bulgarian dual-currency)
  - Adobe table format  (product code + EA qty + price + tax% columns)
  - Fiverr format       (Invoice FIXXXX title, "Service qty price total" rows)
  - Trengo format       (European amounts, "Desc price x qty discount subtotal")
  - GitHub receipt      (Transaction ID as number, USD, no line items)
  - New Relic format    (Invoice No:, USD, usage-based line items)
  - Pharos GBP format   (Invoice Number label, GBP currency, large qty rows)
"""

import re, sys, json, argparse
# ── New: pluggable client profile + myDATA fields + dispatch fields ─────────
from client_profile import get_client_profile
from mydata_fields import extract_mydata_fields
from dispatch_fields import extract_dispatch_fields

MONTH_NAMES = (
    r'(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?'
    r'|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
)

SKIP_WORDS = {
    'PRODUCT','NUMBER','QUANTITY','UNIT','AMOUNT','PRICE','DESCRIPTION',
    'INVOICE','ORIGINAL','TOTAL','TAXES','RATE','ITEM','DETAILS','NET',
    'TAX','GRAND','BILL','PAGE','TO','DATE','ORDER','CUSTOMER','PURCHASE',
    'CURRENCY','TERMS','PAYMENT','CREDIT','CARD','SERVICE','TERM','CONTACT',
    'BILLING','THANK','YOU','FOR','YOUR','BUSINESS','COMMENTS','NOTE',
    'CHARGE','TRANSACTION','SUPPLY','SELF','ASSESS','VAT','SUMMARY',
    'USAGE','PERIOD','TRANSACTIONS','PAYMENTS','DISCOUNT','SUB','SUBTOTAL',
    'METHOD','TYPE','APPLIED','DUE','RECEIPT','BALANCE','SOLD',
}

# Client identity is loaded from a JSON profile at runtime. See client_profile.py.
_PROFILE = get_client_profile()

# ── HTML tag stripper ─────────────────────────────────────────────────────────
_HTML_TAG_RE = re.compile(r'<[^>]+>')

# ── Corporate entity suffix — used to prefer company line over contact name ──
# (e.g. "Ferryscanner.com EOOD" wins over "Philipp Brinkmann" in the To block)
ENTITY_SUFFIX_RE = re.compile(
    r'\b(EOOD|OOD|LTD|LIMITED|GMBH|S\.?A\.?|EPE|AE|ΑΕ|ΑΕΒΕ|AEBE|ΕΠΕ|ΙΚΕ|ΟΕ|'
    r'INC|LLC|BV|NV|AG|CORP|SARL|SRL|KG|PC|IRELAND|IKE|OE)\b',
    re.IGNORECASE
)


def is_table_header(line):
    words = set(line.upper().split())
    return len(words) >= 3 and len(words - SKIP_WORDS) <= 1


def strip_exchange_rate_lines(text):
    text = re.sub(r'[\d\.]+\s+BGN/EUR.*', '', text)
    text = re.sub(r'[\d\.]+\s+BGN\b.*', '', text)
    return text


def parse_amount(s):
    """
    Parse monetary strings robustly:
      3,674.83  -> 3674.83  (US: comma=thousands, dot=decimal)
      5.000,01  -> 5000.01  (EU: dot=thousands, comma=decimal)
      1400.00   -> 1400.00  (plain)
    """
    if not s:
        return None
    s = str(s).strip()
    s = re.sub(r'[\u20ac$\u00a3\*\s]', '', s)
    if not s:
        return None

    has_comma = ',' in s
    has_dot   = '.' in s

    if has_comma and has_dot:
        comma_pos = s.rindex(',')
        dot_pos   = s.rindex('.')
        if dot_pos > comma_pos:
            # US format: 3,674.83 -> remove commas
            s = s.replace(',', '')
        else:
            # EU format: 5.000,01 -> remove dots, comma->dot
            s = s.replace('.', '').replace(',', '.')
    elif has_comma and not has_dot:
        # Could be EU decimal (87,51) or US thousands (3,674)
        parts = s.split(',')
        if len(parts) == 2 and len(parts[1]) <= 2:
            # Decimal: 87,51 -> 87.51
            s = s.replace(',', '.')
        else:
            # Thousands: remove comma
            s = s.replace(',', '')

    try:
        return float(s)
    except Exception:
        return None


def parse_invoice_fields(text: str) -> dict:
    inv: dict = {}

    # ── Strip HTML tags Surya sometimes emits (e.g. <b>Date issued</b>) ──────
    text = _HTML_TAG_RE.sub('', text)

    # -- Invoice Number ----------------------------------------------
    m = (
        # "Invoice Number 3312750411" / "Invoice No: INV01447600" / "Invoice # INV-2025-1024844"
            re.search(r'Invoice\s+(?:Number|No\.?|#)\s*[:\-\s]+([A-Z0-9][\w\-\/]+)', text, re.IGNORECASE) or
            # "Invoice FI45483162319" - alphanumeric title
            re.search(r'^Invoice\s+([A-Z]{1,4}\d{6,})\s*$', text, re.MULTILINE) or
            # "Number\n0000000590" split lines
            re.search(r'(?<!\w)Number\s*\n\s*(\d{5,})', text, re.IGNORECASE) or
            # "Number 0000000590" same line (not Order/Customer/Transaction)
            re.search(r'(?:^|\n)\s*Number\s+([\w\-]{4,})', text, re.IGNORECASE) or
            # Fallback: "Transaction ID ch_XXX" for receipts
            re.search(r'Transaction\s+ID\s+(\S+)', text, re.IGNORECASE)
    )
    if m:
        inv["invoiceNumber"] = m.group(1).strip()

    # -- Order Number -----------------------------------------------
    # FIX: require captured value to start with a letter (Fiverr "FO...", PO, etc.)
    # OR be ≥5 pure digits — this rejects "115M" street numbers grabbed from
    # two-column pdfplumber layouts where "Order number" wraps to the address row.
    m = re.search(
        r'(?:Order\s+(?:Number|No\.?|#)|Purchase\s+Order|PO\s+No\.?)'
        r'\s*[:#\-]?\s+([A-Za-z][A-Za-z0-9\-\/_]{3,}|\d{5,})',
        text, re.IGNORECASE
    )
    if m:
        inv["orderNumber"] = m.group(1).strip()

    # -- Date --------------------------------------------------------
    m = (
        # "Invoice Date 20-DEC-2025" - stop at newline
            re.search(r'Invoice\s+Date\s*[:\-\s]+([^\n]+)', text, re.IGNORECASE) or
            # "Date issued\nFeb 3, 2026" or "Date issued ... Feb 19, 2026" (same/next line)
            re.search(rf'Date\s+issued[^\n]*\n[^\n]*?({MONTH_NAMES}\s+\d{{1,2}},?\s+\d{{4}})', text, re.IGNORECASE) or
            re.search(rf'Date\s+issued\s*\n\s*({MONTH_NAMES}\s+\d{{1,2}},?\s+\d{{4}})', text, re.IGNORECASE) or
            # "Date 2026-02-23" ISO
            re.search(r'\bDate\s+(\d{4}-\d{2}-\d{2})', text, re.IGNORECASE) or
            # "Date\n23.12.2025"
            re.search(r'\bDate\s*\n\s*(\d{1,2}[\.\/\-]\d{1,2}[\.\/\-]\d{4})', text, re.IGNORECASE) or
            # "31 Jan 2026" after label
            re.search(rf'(?:Invoice\s+)?Date\s*[:\s]+(\d{{1,2}}\s+{MONTH_NAMES}\s+\d{{4}})', text, re.IGNORECASE) or
            # "Dec 16, 2025" after label
            re.search(rf'(?:Invoice\s+)?Date\s*[:\-\s]+({MONTH_NAMES}\s+\d{{1,2}},?\s+\d{{4}})', text, re.IGNORECASE) or
            # Generic fallback
            re.search(r'(?<!Tax\s)(?<!Event\s)\bDate\s*[:\s]+(\d{1,2}[\-\/\.]\w+[\-\/\.]\d{2,4})', text, re.IGNORECASE)
    )
    if m:
        inv["invoiceDate"] = m.group(1).strip().split('\n')[0].strip().rstrip('.')

    # ═══════════════════════════════════════════════════════════════════
    # ISSUER (supplier / invoice sender)
    # ═══════════════════════════════════════════════════════════════════
    COMPANY_SUFFIXES = r'\b(LTD|LLC|INC|SA|PC|AE|EPE|OE|IKE|SRL|GMBH|KG|OOD|EOOD|IRELAND|LIMITED|BV|NV|AG|CORP|CO|ΑΕ|ΕΠΕ|ΙΚΕ|ΟΕ)\b'
    issuer: dict = {}

    # ── Fiverr: issuer is in footer, not header ───────────────────────
    if re.search(r'Invoice\s+FI\d{6,}', text, re.IGNORECASE):
        m = re.search(r'(Fiverr\s+International\s+Ltd\.?)', text, re.IGNORECASE)
        if m:
            issuer["name"] = m.group(1).strip()
        m = re.search(r'(\d+\s+[\w\s]+St\.?,\s*Tel Aviv[^\n]+)', text, re.IGNORECASE)
        if m:
            issuer["address"] = m.group(1).strip()
        issuer["city"]    = "Tel Aviv"
        issuer["country"] = "Israel"
        m = re.search(r'Company\s+no[:\s]+(\d+)', text, re.IGNORECASE)
        if m:
            issuer["registrationNumber"] = m.group(1).strip()
        m = re.search(r'VAT\s+ID[^:]*:\s*([\w]+)', text, re.IGNORECASE)
        if m:
            issuer["vatNumber"] = m.group(1).strip()

    # ── Greek / Bulgarian / generic: issuer is at top of document ────
    if not issuer.get("name"):
        SKIP_ISSUER = re.compile(
            r'(Bill\s+To|Billed\s+To|Client|Buyer|Αγοραστ|Πελάτ|Πελατ|'
            r'Purchased\s+on|through\s+Fiverr)',
            re.IGNORECASE
        )
        for line in text.split('\n'):
            line = line.strip()
            if not line or len(line) < 3 or len(line) > 120:
                continue
            if is_table_header(line):
                continue
            if re.search(COMPANY_SUFFIXES, line, re.IGNORECASE):
                if not SKIP_ISSUER.search(line) and not _PROFILE.should_skip_as_issuer(line):
                    issuer["name"] = line
                    break
        # Fallback: titled line at doc start
        if not issuer.get("name"):
            m = re.search(r'^([A-ZΑ-Ω][\w\s\.,]{2,60}(?:Inc\.|LLC\.|Ltd\.|GmbH|Α\.Ε\.|ΕΠΕ|ΙΚΕ))\s*$', text, re.MULTILINE)
            if m:
                issuer["name"] = m.group(1).strip()

    # ── VAT number (supplier) ─────────────────────────────────────────
    for pat in [
        r'(?:ΑΦΜ|Α\.Φ\.Μ\.)[\s:]*(?:EL\s*-?\s*)?(\d{9,10})',
        r'\bVAT\s+N(?:o|umber)\.?\s*[:\s]+([A-Z]{2}[\d\w]{6,})',
        r'\bVAT\s*ID\s*[:\s]+([A-Z]{2}[\d\w]{6,})',
        r'\bVAT\s*[:\s]+([A-Z]{2}[\d\w]{6,})',
        r'Company\s+ID\s+(\d{6,})',
    ]:
        for m in re.finditer(pat, text, re.IGNORECASE):
            val = m.group(1).strip()
            if not _PROFILE.is_client_vat(val):
                issuer["vatNumber"] = val
                break
        if issuer.get("vatNumber"):
            break

    # ── Tax ID / registration number ──────────────────────────────────
    for pat in [
        r'(?:ΑΡ\.?\s*ΓΕΜΗ|ΓΕΜΗ)[:\s]*(\d{6,})',
        r'Registration\s+(?:No|Number)\.?\s*[:\s]+([\w\-]{4,})',
        r'Reg\.?\s+No\.?\s*[:\s]+([\w\-]{4,})',
        r'Company\s+no[:\s]+(\d+)',
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            issuer["registrationNumber"] = m.group(1).strip()
            break

    # ── Address ───────────────────────────────────────────────────────
    if not issuer.get("address"):
        m = re.search(
            r'(?:(?:^|\n)Address[:\s]+|Διεύθυνση[:\s]+|Οδός[:\s]+)([^\n]{5,80})',
            text, re.IGNORECASE | re.MULTILINE)
        if m:
            issuer["address"] = m.group(1).strip()

    # ── City & post code ──────────────────────────────────────────────
    m = re.search(r'\b(\d{3}\s?\d{2})\b\s+([Α-Ωα-ωA-Za-z][\w\s]{2,30})', text)
    if m:
        issuer["postCode"] = m.group(1).replace(" ", "")
        issuer["city"]     = m.group(2).strip()

    # ── Country ───────────────────────────────────────────────────────
    COUNTRY_HINTS = {
        "Greece": r'\b(Greece|Ελλάδα|Ελλαδα|ΕΛΛΑΔΑ|GR\b)',
        "Bulgaria": r'\b(Bulgaria|BULGARIA|BG\b)',
        "Israel": r'\b(Israel|ISRAEL|Tel Aviv)',
        "UK": r'\b(United Kingdom|England|Scotland|Wales|GB\b|UK\b)',
        "Germany": r'\b(Germany|Deutschland|DE\b)',
        "Netherlands": r'\b(Netherlands|Nederland|NL\b)',
        "Ireland": r'\b(Ireland|IE\b)',
    }
    for country, pat in COUNTRY_HINTS.items():
        if re.search(pat, text, re.IGNORECASE):
            issuer.setdefault("country", country)
            break

    # ── DOY (Greek tax office) ────────────────────────────────────────
    m = re.search(r'(?:ΔΟΥ|Δ\.Ο\.Υ\.)[:\s]+([\w\s]{3,40}?)(?=\n|,|\.|ΑΦΜ|$)', text, re.IGNORECASE)
    if m:
        issuer["doy"] = m.group(1).strip()

    # ── Profession / business activity ───────────────────────────────
    m = re.search(r'(?:Επάγγελμα|Δραστηριότητα|Profession|Activity)[:\s]+([^\n]{3,80})', text, re.IGNORECASE)
    if m:
        issuer["profession"] = m.group(1).strip()

    # ── Manager / authorized person ───────────────────────────────────
    m = re.search(r'Manager\s+([^\n]{3,60})', text, re.IGNORECASE)
    if m and not _PROFILE.should_skip_as_issuer(m.group(1)):
        issuer["manager"] = m.group(1).strip()

    # ── Phone ─────────────────────────────────────────────────────────
    m = re.search(r'(?:Tel(?:ephone)?|Τηλ|Phone)[.:\s]+([\d\s\+\(\)\-]{7,20})', text, re.IGNORECASE)
    if m:
        issuer["phone"] = m.group(1).strip()

    # ── Email ─────────────────────────────────────────────────────────
    m = re.search(r'([\w.+%-]+@[\w.-]+\.[A-Za-z]{2,})', text)
    if m:
        issuer["email"] = m.group(1).strip()

    # ── IBAN ──────────────────────────────────────────────────────────
    m = re.search(r'\b([A-Z]{2}\d{2}[\w\d]{4,}(?:\s[\w\d]{4}){0,6})\b', text)
    if m:
        candidate = m.group(1).replace(" ", "")
        if 15 <= len(candidate) <= 34:
            issuer["iban"] = candidate

    # ── SWIFT / BIC ─────────────────────────────────────────────────
    SWIFT_RE = re.compile(r'\b([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b')
    SWIFT_SKIP = re.compile(r'(EURO|BANK|IBAN|TOTAL|PAID|CARD|TRAN|ORIG|ELEC|RETH|HAVE|COMP|WITH|SERV|CONS|FINV)', re.IGNORECASE)
    for sw_m in SWIFT_RE.finditer(text):
        val = sw_m.group(1)
        if len(val) in (8, 11) and not SWIFT_SKIP.search(val):
            issuer["swift"] = val
            break

    # ── Bank name ─────────────────────────────────────────────────────
    m = re.search(r'([\w\s]+(?:Bank|Τράπεζα|FINV|PIRAEUS|ALPHA|EUROBANK|NBG)[\w\s]*),?', text, re.IGNORECASE)
    if m:
        issuer["bank"] = m.group(1).strip()

    # Populate legacy key for backward compat
    if issuer.get("name"):
        issuer["name"] = re.sub(r'\s+(?:INVOICE|RECEIPT|BILL|DOCUMENT|ORIGINAL)\s*$', '', issuer["name"], flags=re.IGNORECASE).strip()
    inv["supplier"]        = issuer.get("name")
    inv["supplierAddress"] = issuer.get("address")
    inv["supplierVat"]     = issuer.get("vatNumber")
    inv["issuer"]          = issuer

    # ═══════════════════════════════════════════════════════════════════
    # RECIPIENT (client / bill-to / buyer)
    # ═══════════════════════════════════════════════════════════════════
    recipient: dict = {}

    # ── Name (standard patterns) ──────────────────────────────────────
    for pat in [
        r'(?:^|\n)Client\s*\n([^\n]+)',
        r'(?:^|\n)(?:Στοιχεία\s+Πελάτη|ΣΤΟΙΧΕΙΑ\s+ΠΕΛΑΤΗ)[:\s]*\n([^\n]+)',
        r'(?:Bill(?:ed)?\s+To|Billed\s+To)[:\n]\s*([^\n]+)',
        r'(?:^|\n)To\s*\n([^\n]+)',
        r'Recipient[:\s]+([^\n]+)',
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            candidate = m.group(1).strip()
            if len(candidate) > 3 and not is_table_header(candidate):
                candidate = re.sub(
                    r'\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*$',
                    '', candidate, flags=re.IGNORECASE).strip()
                recipient["name"] = candidate
                break

    # FIX: If the captured name has no corporate suffix (EOOD/LTD/SA/AEBE etc.),
    # the parser probably grabbed a contact-person line instead of the company
    # line. Scan the next 5 lines after "To" / "Bill To" and prefer one that
    # DOES have a corporate suffix.
    need_company_scan = (
            not recipient.get("name") or
            not ENTITY_SUFFIX_RE.search(recipient.get("name", ""))
    )
    if need_company_scan:
        to_block = re.search(
            r'(?:^|\n)(?:To|Bill\s+To|Billed\s+To|Recipient|Client)\b[^\n]*'
            r'((?:\n[^\n]+){1,5})',
            text, re.IGNORECASE
        )
        if to_block:
            for line in to_block.group(1).split('\n'):
                line = line.strip()
                if len(line) < 3 or is_table_header(line):
                    continue
                if ENTITY_SUFFIX_RE.search(line):
                    line = re.sub(
                        r'\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*$',
                        '', line, flags=re.IGNORECASE).strip()
                    if not (issuer.get("name") and line == issuer["name"]):
                        recipient["name"] = line
                        break

    # Fallback: known client name from the active client profile
    if not recipient.get("name"):
        matched = _PROFILE.match_name(text)
        if matched:
            candidate = re.sub(
                r'\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*$',
                '', matched, flags=re.IGNORECASE).strip()
            recipient["name"] = candidate

    # ── VAT number (client) ───────────────────────────────────────────
    for pat in [
        r'(?:Company\s+ID|Tax\s+ID)[:\s]+([A-Z]{2}[\d]{6,})',
        r'(?:ΑΦΜ|Α\.Φ\.Μ\.)\s*[:\s]*([\d]{9,10})',
        r'\b(EL\d{9})\b',
        r'\b(BG\d{9,10})\b',
    ]:
        for m in re.finditer(pat, text, re.IGNORECASE):
            val = m.group(1).strip()
            if val != issuer.get("vatNumber", ""):
                recipient["vatNumber"] = val
                break
        if recipient.get("vatNumber"):
            break
    # Known client VAT — first match from the profile that appears in the text
    if not recipient.get("vatNumber"):
        for v in _PROFILE.vats:
            if v and v in text:
                recipient["vatNumber"] = v
                break

    # ── Registration number ───────────────────────────────────────────
    m = re.search(r'(?:ΑΡ\.?\s*ΓΕΜΗ|ΓΕΜΗ\s+Πελάτη)[:\s]*(\d{6,})', text, re.IGNORECASE)
    if m:
        recipient["registrationNumber"] = m.group(1).strip()

    # ── Address ───────────────────────────────────────────────────────
    if not recipient.get("address"):
        addr = _PROFILE.match_address(text)
        if addr:
            recipient["address"] = addr

    # ── City & post code ──────────────────────────────────────────────
    for pat in [
        r'(?:Athens|Αθήνα|Sofia|Thessaloniki|Θεσσαλονίκη)[,\s]*(\d{3,5})',
        r'(\d{4,5})[,\s]*(?:Athens|Αθήνα|Sofia|Thessaloniki|Θεσσαλονίκη)',
    ]:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            recipient["postCode"] = m.group(1).strip()
            break
    for city in ["Athens", "Sofia", "Αθήνα", "Thessaloniki", "Θεσσαλονίκη", "Piraeus", "Πειραιάς"]:
        if re.search(r'\b' + city + r'\b', text, re.IGNORECASE):
            recipient.setdefault("city", city)
            break

    # ── Country ───────────────────────────────────────────────────────
    if recipient.get("vatNumber", "").startswith("EL") or re.search(r'Greece|Ελλάδα', text, re.IGNORECASE):
        recipient.setdefault("country", "Greece")
    elif recipient.get("vatNumber", "").startswith("BG") or re.search(r'Bulgaria', text, re.IGNORECASE):
        recipient.setdefault("country", "Bulgaria")

    # ── DOY ───────────────────────────────────────────────────────────
    m = re.search(r'ΔΟΥ\s+Πελάτη[:\s]+([\w\s]{3,40}?)(?=\n|,|\.|ΑΦΜ|$)', text, re.IGNORECASE)
    if m:
        recipient["doy"] = m.group(1).strip()

    # ── Manager / contact ─────────────────────────────────────────────
    m = re.search(r'Manager\s+([^\n]{3,50})', text, re.IGNORECASE)
    if m:
        candidate = m.group(1).strip()
        mgr_patterns = _PROFILE.manager_patterns()
        if not mgr_patterns or any(p.search(candidate) for p in mgr_patterns):
            recipient["manager"] = candidate

    # ── Phone ─────────────────────────────────────────────────────────
    phones = re.findall(r'(?:Tel|Τηλ|Phone)[.:\s]+([\d\s\+\(\)\-]{7,20})', text, re.IGNORECASE)
    if len(phones) > 1:
        recipient["phone"] = phones[1].strip()
    elif phones and not issuer.get("phone"):
        recipient["phone"] = phones[0].strip()

    # Populate legacy keys
    inv["client"]            = recipient.get("name")
    inv["clientVat"]         = recipient.get("vatNumber")
    inv["recipient"]         = recipient

    clean = strip_exchange_rate_lines(text)

    # -- Currency -----------------------------------------------------
    if re.search(r'TOTAL\s+GBP|\u00a3\s*[\d]', text):
        currency = "GBP"
    elif re.search(r'\bUSD\b|\$\s*[\d]', text) and not re.search(r'\bEUR\b|\u20ac', text):
        currency = "USD"
    elif re.search(r'\bUSD\b|\$\s*[\d]', text):
        currency = "USD" if re.search(r'Total\s+\$', text) else "EUR"
    else:
        currency = "EUR"
    inv["currency"] = currency

    # -- Total --------------------------------------------------------
    # FIX: use \s* (not \s+) between "Total" and "(EUR)" and after ")" to tolerate
    # pdfplumber whitespace variations. Anchor to start-of-line so the column
    # HEADER "Total (EUR)" (which has no following number) is skipped — only the
    # actual TOTAL row "Total (EUR) 176.90" matches.
    m = (
            re.search(r'GRAND\s+TOTAL\s*\(?\s*EUR\s*\)?\s*[:\-]?\s*([\d,\.]+)', clean, re.IGNORECASE) or
            re.search(r'Amount\s+Due\s*\(?\s*EUR\s*\)?\s*[:\-]?\s*([\d,\.]+)', clean, re.IGNORECASE) or
            # "Total (EUR) 176.90" on its own line (not column header)
            re.search(r'(?:^|\n)\s*Total\s*\(\s*EUR\s*\)\s*[:\-]?\s+([\d,\.]+)', clean, re.IGNORECASE | re.MULTILINE) or
            # "Total (EUR)\n176.90" split across lines
            re.search(r'Total\s*\(\s*EUR\s*\)\s*\n\s*([\d,\.]+)', clean, re.IGNORECASE) or
            re.search(r'Invoice\s+Total\s*\(?USD\)?\s*[:\s]+([\$\d,\.]+)', clean, re.IGNORECASE) or
            re.search(r'TOTAL\s+GBP\s+([\d,\.]+)', clean, re.IGNORECASE) or
            re.search(r'^Total\s+[\$\u20ac\u00a3]?([\d,\.]+)\s*(?:USD|EUR|GBP)?\*?\s*$', clean, re.IGNORECASE | re.MULTILINE) or
            re.search(r'PAYMENT\s+AMOUNT[^\n]*?([\d\s,\.]+)\s*EUR', clean, re.IGNORECASE) or
            re.search(r'Total\s+\$?([\d,\.]+)\s*(?:USD)?\*?\s*$', clean, re.IGNORECASE | re.MULTILINE)
    )
    if m:
        v = parse_amount(m.group(1))
        if v:
            inv["total"] = v

    # -- Subtotal ------------------------------------------------------
    # FIX: removed the "Total (EUR)" fallback from this chain — it conflicted
    # with the total chain. Use explicit "Net Amount" / "Sub-Total" labels only.
    # The subtotal=total inference for 0% VAT invoices is done below.
    m = (
            re.search(r'NET\s+AMOUNT\s*\(?EUR\)?\s+([\d,\.]+)', clean, re.IGNORECASE) or
            re.search(r'NET\s+AMOUNT[^\n]*([\d\s,\.]+)\s*EUR', clean, re.IGNORECASE) or
            re.search(r'Sub-?Total\s*[:\$]?\s*([\d,\.]+)', clean, re.IGNORECASE)
    )
    if m:
        v = parse_amount(m.group(1))
        if v:
            inv["subtotal"] = v

    # -- VAT amount + rate ---------------------------------------------
    m = re.search(r'VAT\s*\((\d+)%\)[^\n]*([\d\s,\.]+)\s*EUR', clean, re.IGNORECASE)
    if m:
        inv["vatRate"] = int(m.group(1))
        v = parse_amount(m.group(2))
        if v is not None:
            inv["vat"] = v

    # FIX: 0% VAT export invoices (Fiverr et al) — if total is set but subtotal
    # is missing AND there's no explicit VAT line in the document, assume
    # subtotal = total and vatRate = 0.
    if inv.get("total") and not inv.get("subtotal"):
        has_explicit_vat = bool(re.search(
            r'(?:^|\n)\s*VAT\s*(?:\(\d+%\)|Amount|Total|Rate)?[^\n]*\d',
            clean, re.IGNORECASE | re.MULTILINE
        ))
        if not has_explicit_vat:
            inv["subtotal"] = inv["total"]
            inv.setdefault("vatRate", 0)
            inv.setdefault("vat", 0.0)

    # Sanity: if subtotal ≈ total and no VAT found, infer 0% VAT
    if not inv.get("vat") and inv.get("subtotal") and inv.get("total"):
        if abs((inv.get("total") or 0) - (inv.get("subtotal") or 0)) < 0.02:
            inv.setdefault("vatRate", 0)
            inv["vat"] = 0.0

    # -- Payment method ------------------------------------------------
    m = (
            re.search(r'Payment\s+Terms?\s*[:\-\s]+(.+)', text, re.IGNORECASE) or
            re.search(r'Payment\s+Method\s*[:\-\s]+(.+)', text, re.IGNORECASE) or
            re.search(r'Paid\s+with\s+(\w+)', text, re.IGNORECASE) or
            re.search(r'Charged\s+to\s+(\w+(?:\s+\w+)?)', text, re.IGNORECASE)
    )
    if m:
        inv["paymentMethod"] = m.group(1).strip().split('\n')[0].strip()

    # -- Line Items ----------------------------------------------------
    line_items = []

    # Format A0: Bulgarian dual-currency service invoice
    if not line_items:
        bul_lines = text.split('\n')
        bul_items_raw = []
        i = 0
        while i < len(bul_lines):
            line = bul_lines[i].strip()
            m = re.match(
                r'^(\d+)\.\s+(.+?)\s+(\d+(?:\.\d+)?)\s+'
                r'(?:pcs|ea|units?|hours?|hrs?|piece)\s+'
                r'([\d,\.]+)\s+(?:EUR|USD|GBP)',
                line, re.IGNORECASE
            )
            if m:
                item_num  = int(m.group(1))
                desc      = m.group(2).strip()
                qty       = float(m.group(3))
                price_eur = parse_amount(m.group(4))
                j = i + 1
                while j < len(bul_lines):
                    nxt = bul_lines[j].strip()
                    if not nxt:
                        j += 1
                        continue
                    desc_words = desc.split()[:3]
                    is_date_continuation = (
                            any(nxt.startswith(w) for w in desc_words)
                            and re.search(r'\b(January|February|March|April|May|June|July|'
                                          r'August|September|October|November|December|\d{4})\b',
                                          nxt, re.IGNORECASE)
                    )
                    if is_date_continuation:
                        date_part = re.sub(r'\s+[\d,\.]+\s+BGN.*$', '', nxt).strip()
                        date_part = re.sub(r'\s+[\d,\.]+\s+BGN/EUR.*$', '', date_part).strip()
                        for w in desc_words:
                            if date_part.startswith(w):
                                date_part = date_part[len(w):].strip()
                        if date_part:
                            desc = desc + ' (' + date_part + ')'
                        i = j
                    break
                if price_eur and price_eur > 0 and qty > 0:
                    bul_items_raw.append({
                        "description":  desc,
                        "supplierCode": "",
                        "quantity":     qty,
                        "unit":         "pcs",
                        "unitPrice":    price_eur,
                        "totalPrice":   round(qty * price_eur, 2),
                        "vatRate":      0,
                        "currency":     "EUR",
                    })
            i += 1

        if bul_items_raw:
            line_items = bul_items_raw

    # Format A: Adobe table
    adobe_pat = re.compile(
        r'^(\d{6,})\s+(.+?)\s+(\d+)\s+(EA|PCS?|UNIT|HOUR|HR)\s+'
        r'([\d,\.]+)\s+([\d,\.]+)\s+[\d\.]+%\s+[\d,\.]+\s+([\d,\.]+)',
        re.MULTILINE | re.IGNORECASE)
    for lm in adobe_pat.finditer(clean):
        qty   = float(lm.group(3))
        price = parse_amount(lm.group(5))
        total = parse_amount(lm.group(7))
        if price and total:
            line_items.append({
                "description":  lm.group(2).strip(),
                "supplierCode": lm.group(1),
                "quantity":     qty,
                "unit":         lm.group(4).upper(),
                "unitPrice":    price,
                "totalPrice":   total,
                "vatRate":      0,
                "currency":     inv.get("currency", "EUR"),
            })

    # Format B: Trengo
    if not line_items:
        trengo_pat = re.compile(
            r'^([\w\s\d]+?)\s+([\d,\.]+)\s+(?:EUR|\u20ac)\s+x\s+(-?\d+)\s+'
            r'(?:-[\d,\.]+\s+(?:EUR|\u20ac)\s+)?([\d,\.]+)\s+(?:EUR|\u20ac)',
            re.MULTILINE)
        for lm in trengo_pat.finditer(clean):
            desc = lm.group(1).strip()
            if is_table_header(desc) or len(desc) < 3:
                continue
            if desc.lower() in ('total', 'amount due', 'sub total', 'subtotal'):
                continue
            price = parse_amount(lm.group(2))
            qty   = abs(int(lm.group(3)))
            total = parse_amount(lm.group(4))
            if price and total:
                line_items.append({
                    "description":  desc,
                    "supplierCode": "",
                    "quantity":     qty,
                    "unit":         "EA",
                    "unitPrice":    price,
                    "totalPrice":   total,
                    "vatRate":      0,
                    "currency":     inv.get("currency", "EUR"),
                })

    # Format C: Fiverr "Description qty price total" (no unit column)
    if not line_items:
        fiverr_clean = clean
        for stop_pat in [
            r'\nMethod\s+Date\s+Total',
            r'\nPaid\s+with',
            r'\nPurchased\s+on',
        ]:
            m_stop = re.search(stop_pat, fiverr_clean, re.IGNORECASE)
            if m_stop:
                fiverr_clean = fiverr_clean[:m_stop.start()]
                break

        fiverr_pat = re.compile(
            r'^([\w][\w\s]+?)\s+(-?\d+)\s+([\d,\.]+)\s+([\d,\.\-]+)\s*$',
            re.MULTILINE)

        SKIP_FIVERR = {
            'total', 'method', 'date', 'service', 'quantity',
            'unit price', 'total (eur)', 'paid with card', 'paid with',
            'electronic document', 'original', 'to', 'order', 'number',
            'tax', 'id', 'page', 'document', 'have an invoice',
        }
        SKIP_SINGLE = {
            'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
            'sofia','bulgaria','athens','greece','israel','tel','aviv','london',
            'berlin','paris','amsterdam','page','electronic','original','rethink',
        }

        for lm in fiverr_pat.finditer(fiverr_clean):
            desc  = lm.group(1).strip()
            qty   = float(lm.group(2))
            price = parse_amount(lm.group(3))
            total = parse_amount(lm.group(4))

            if is_table_header(desc) or len(desc) < 3:
                continue
            if desc.lower() in SKIP_FIVERR:
                continue
            if len(desc.split()) == 1 and desc.lower() in SKIP_SINGLE:
                continue
            if re.match(r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b', desc, re.IGNORECASE):
                continue
            if price and 2015 <= price <= 2035:
                continue
            if price is None or total is None:
                continue
            if qty != 0:
                expected  = round(abs(qty) * price, 2)
                tolerance = max(0.10, abs(total) * 0.05)
                if abs(expected - abs(total)) > tolerance:
                    continue

            line_items.append({
                "description":  desc,
                "supplierCode": "",
                "quantity":     qty,
                "unit":         "EA",
                "unitPrice":    price,
                "totalPrice":   total,
                "vatRate":      0,
                "currency":     inv.get("currency", "EUR"),
            })

    # Format C2: Fiverr column-scrambled (Surya reads table columns top-to-bottom)
    if not line_items:
        header_m = re.search(
            r'(?:Service|Description)\s*\n\s*Quantity\s*\n\s*Unit\s+price',
            clean, re.IGNORECASE)
        if header_m:
            table_text = clean[header_m.end():]
            for stop in [r'\nTotal\s*\(EUR\)\s*\nMethod', r'\nMethod\s*\n',
                         r'\nPaid\s+with', r'\nPurchased\s+on']:
                m_stop = re.search(stop, table_text, re.IGNORECASE)
                if m_stop:
                    table_text = table_text[:m_stop.start()]
                    break
            table_text = re.sub(r'^.*?Total\s*\(EUR\)\s*\n', '', table_text,
                                flags=re.IGNORECASE)
            _C2_SKIP = {'total (eur)', 'total', 'subtotal', 'method', 'date',
                        'quantity', 'unit price (eur)', 'service'}

            def _is_num(s):
                try: float(s.replace(',', '.')); return True
                except: return False

            c2_lines = [l.strip() for l in table_text.split('\n') if l.strip()]
            ci = 0
            while ci < len(c2_lines):
                cline = c2_lines[ci]
                if (re.match(r'^[A-Za-z]', cline) and not _is_num(cline)
                        and cline.lower() not in _C2_SKIP and len(cline) >= 3):
                    c2_nums = []
                    cj = ci + 1
                    while cj < len(c2_lines) and _is_num(c2_lines[cj]):
                        c2_nums.append(float(c2_lines[cj].replace(',', '.')))
                        cj += 1
                    if len(c2_nums) >= 2:
                        c2_price = c2_nums[0]
                        c2_total = c2_nums[1]
                        if (abs(c2_price - c2_total) < 0.50 or
                                (c2_total > 0 and abs(c2_price - c2_total) / c2_total < 0.10)):
                            line_items.append({
                                "description":  cline,
                                "supplierCode": "",
                                "quantity":     1.0,
                                "unit":         "EA",
                                "unitPrice":    c2_price,
                                "totalPrice":   c2_total,
                                "vatRate":      0,
                                "currency":     inv.get("currency", "EUR"),
                            })
                    ci = cj
                else:
                    ci += 1

    # Format D: Service invoice multiline
    if not line_items:
        svc_pat = re.compile(
            r'(\d+)\.\s+([\w\s\-,\.]+?)\n(?:[\w\s\-,\.\(\)\/]+\n)?'
            r'([\d\.]+)\s+(?:pcs|ea|hrs?|hours?|units?)\s+([\d\.]+(?:\.\d+)?)\s+EUR',
            re.IGNORECASE)
        for lm in svc_pat.finditer(clean):
            qty   = float(lm.group(3))
            price = float(lm.group(4))
            line_items.append({
                "description":  lm.group(2).strip(),
                "supplierCode": "",
                "quantity":     qty,
                "unit":         "pcs",
                "unitPrice":    price,
                "totalPrice":   round(qty * price, 2),
                "vatRate":      inv.get("vatRate", 0),
                "currency":     inv.get("currency", "EUR"),
            })

    # Format E: New Relic/Pharos - "Description ... $amount" at line end
    if not line_items:
        usage_pat = re.compile(
            r'^([A-Za-z][^\n]{5,80}?)\s+[\$\u00a3]?([\d,\.]+)\s*$',
            re.MULTILINE)
        # Lines that LOOK like "text number" but are NOT line items. The old
        # filter only skipped New-Relic-specific junk, so on ordinary invoices
        # this format fabricated items from dates ("Date of issue April 30, 2026"),
        # the payment P.O. box ("P.O. Box 104477" → a €104,477 item!), page
        # footers ("Page 1 of 1"), and address/total lines. Expanded to block all
        # of these. Better to extract NO line items than fabricated ones.
        SKIP_USAGE = re.compile(
            r'(Sub.?Total|Invoice\s+Total|Tax:|Balance|Copyright|For\s+questions'
            r'|New\s+Relic\s+Inc|Powered\s+by|All\s+rights|trademarks'
            r'|Date\s+(of\s+issue|due)|Issue\s+date|Due\s+date'      # date lines
            r'|P\.?\s*O\.?\s*Box|Payment\s+address|Pay\s+online'      # payment/PO box
            r'|Page\s+\d+\s+of|Page\s+\d+'                            # page footers
            r'|Amount\s+due|Grand\s+total|Total\s+due|Balance\s+due'  # totals lines
            r'|VAT\b|Tax\s+ID|Invoice\s+(number|date)|Order\s+number' # meta lines
            r'|^\s*\d{1,5}\s+[A-Z]'                                   # "548 Market Street"-style address
            r'|Street|Avenue|Box\s+\d|California|Greece|Athens|United\s+States)',
            re.IGNORECASE)
        for lm in usage_pat.finditer(clean):
            desc = lm.group(1).strip()
            if is_table_header(desc) or SKIP_USAGE.search(desc):
                continue
            # Reject descriptions that are mostly a date (e.g. "April 30,") or
            # that are just a label with no real product/service text.
            if re.match(r'^[A-Z][a-z]{2,9}\s+\d{1,2},?\s*$', desc):  # "April 30,"
                continue
            # Reject month-name date ranges, incl. ones whose separator got eaten
            # by a NUL strip ("Apr 30May 31,", "Apr 30-May 31"). Starts with a
            # 3-letter month abbrev + day, then another month name.
            if re.match(r'^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}'
                        r'[\s\-\u2013]*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)',
                        desc, re.IGNORECASE):
                continue
            price = parse_amount(lm.group(2))
            # Sanity bound: a single line item over €1,000,000 from this loose
            # pattern is almost always a misread (e.g. a PO box or postal code),
            # so reject it rather than fabricate a huge total.
            if price and price > 0 and price < 1e6:
                line_items.append({
                    "description":  desc,
                    "supplierCode": "",
                    "quantity":     1,
                    "unit":         "EA",
                    "unitPrice":    price,
                    "totalPrice":   price,
                    "vatRate":      0,
                    "currency":     inv.get("currency", "EUR"),
                })

    # Format F: Pharos large-qty rows
    if not line_items:
        pharos_pat = re.compile(
            r'^(.+?)\s+([\d,\.]+)\s+([\d,\.]+)\s+(?:No\s+VAT\s+)?([\d,\.]+)\s*$',
            re.MULTILINE)
        for lm in pharos_pat.finditer(clean):
            desc  = lm.group(1).strip()
            if is_table_header(desc) or len(desc) < 5:
                continue
            total = parse_amount(lm.group(4))
            price = parse_amount(lm.group(3))
            qty   = parse_amount(lm.group(2))
            if total and total > 0:
                line_items.append({
                    "description":  desc,
                    "supplierCode": "",
                    "quantity":     qty or 1,
                    "unit":         "EA",
                    "unitPrice":    price or total,
                    "totalPrice":   total,
                    "vatRate":      0,
                    "currency":     inv.get("currency", "EUR"),
                })

    inv["lineItems"] = line_items

    # -- Confidence ----------------------------------------------------
    score = 40
    if inv.get("invoiceNumber"): score += 15
    if inv.get("invoiceDate"):   score += 10
    if inv.get("supplier"):      score += 10
    if inv.get("total"):         score += 10
    if line_items:               score += 15
    inv["confidence"] = min(score, 100)

    # ── myDATA header fields (MARK / UID / Auth Code / Provider) ────────────────
    mydata = extract_mydata_fields(text)
    if mydata.get("mark") and not inv.get("mark"):
        inv["mark"] = mydata["mark"]
    inv["uid"]                = mydata.get("uid")
    inv["authenticationCode"] = mydata.get("authenticationCode")
    inv["provider"]           = mydata.get("provider")

    # ── Dispatch fields (for combined Τιμολόγιο - Δελτίο Αποστολής) ─────────────
    dispatch = extract_dispatch_fields(text)
    inv["dispatchDate"]  = dispatch.get("dispatchDate")
    inv["vehicleNumber"] = dispatch.get("vehicleNumber")
    inv["purpose"]       = dispatch.get("purpose")

    return inv


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--text-file", help="Path to plain-text file to parse")
    group.add_argument("--text",      help="Raw text string")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    text = open(args.text_file, encoding="utf-8").read() if args.text_file else args.text
    print(json.dumps(parse_invoice_fields(text), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()