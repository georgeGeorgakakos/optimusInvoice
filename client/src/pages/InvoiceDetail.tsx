import { useParams, useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  FileText,
  Building2,
  CheckCircle2,
  Loader2,
  Sparkles,
  Search,
  Keyboard,
  AlertTriangle,
  Trash2,
  Eye,
  EyeOff,
  Download,
  ZoomIn,
  ZoomOut,
  Clock,
  Globe,
  ShieldCheck,
  XCircle,
  ChevronDown,
  ChevronUp,
  Terminal,
  Languages,
} from "lucide-react";
import { useState, useEffect, useMemo, useCallback } from "react";
import { toast } from "sonner";

// ═════════════════════════════════════════════════════════════════════════════
// i18n MODULE (inline — no external dependencies)
// ═════════════════════════════════════════════════════════════════════════════

type Language = "en" | "el";

const LANG_STORAGE_KEY = "optimus.invoiceDetail.lang";

/** All UI labels in EN and EL. */
const TRANSLATIONS = {
  en: {
    // Header
    invoiceDetails:   "Invoice Details",
    creditNote:       "Credit Note",
    cmrDetails:       "CMR Details",
    dispatchNote:     "Dispatch Note",
    backToInvoices:   "Back to Invoices",
    invoiceNotFound:  "Invoice not found",
    previewPdf:       "Preview PDF",
    hidePdf:          "Hide PDF",
    processWithMl:    "Process with ML",
    reprocess:        "Reprocess",
    deleteInvoice:    "Delete invoice",
    download:         "Download",
    originalPdf:      "Original Invoice PDF",
    loadingPdf:       "Loading PDF...",
    failedLoadPdf:    "Failed to load PDF",

    // Status banner
    matchingProgress: "Matching Progress",
    submitForApproval:"Submit for Approval",
    pushToOptimusDb:  "Push to OptimusDB",
    pushToErp:        "Push to ERP",
    approvalHistory:  "Approval History",
    pleaseWait:       "Please wait while we process your document",
    stillWorking:     "Still working — complex documents take time...",
    dualPassOcr:      "Dual-pass OCR on scanned documents can take 2-3 minutes...",
    downloadingLang:  "First-time OCR downloads language data (~15MB)...",

    // Non-invoice banner
    notAnInvoiceTitle:"This document is not an invoice",
    notAnInvoiceBody: "It was classified as a different document type, so invoice fields were not extracted.",
    classifiedAs:     "Classified as",
    overrideHint:     "If this is wrong, reprocess or change the document type.",

    // Card titles
    issuer:           "Issuer",
    recipient:        "Recipient",
    invoice:          "Invoice",
    financialSummary: "Financial Summary",
    additionalFields: "Additional Fields",
    references:       "References",
    addressSection:   "Address",
    contactSection:   "Contact",
    bankingSection:   "Banking",
    registrationSection: "Registration",

    // Issuer/Recipient fields
    name:             "Name",
    tradeName:        "Trade Name",
    legalForm:        "Legal Form",
    tagline:          "Tagline",
    vatNumber:        "VAT / Tax ID",
    taxId:            "Tax ID",
    registrationNumber:"Reg. No.",
    withholdingTaxFile:"Withholding Tax File",
    doy:              "Tax Office (DOY)",
    gemi:             "GEMI",
    profession:       "Profession",
    manager:          "Manager",
    branch:           "Branch",
    contactPerson:    "Contact Person",
    customerNumber:   "Customer No.",
    address:          "Address",
    street:           "Street",
    building:         "Building",
    floor:            "Floor",
    city:             "City",
    region:           "Region",
    postCode:         "Post Code",
    country:          "Country",
    phone:            "Phone",
    fax:              "Fax",
    email:            "Email",
    website:          "Website",
    iban:             "IBAN",
    swift:            "SWIFT / BIC",
    bank:             "Bank",
    accountName:      "Account Name",

    // Invoice metadata
    number:           "Number",
    date:             "Date",
    dueDate:          "Due Date",
    orderNumber:      "Order No.",
    purchaseOrder:    "Purchase Order",
    contractNumber:   "Contract",
    quoteNumber:      "Quote",
    previousInvoice:  "Previous Invoice",
    deliveryNote:     "Delivery Note",
    servicePeriod:    "Service Period",
    currency:         "Currency",
    exchangeRate:     "Exchange Rate",
    paymentMethod:    "Payment Method",
    paymentStatus:    "Payment Status",
    paymentDate:      "Payment Date",
    mark:             "MARK",
    uid:              "UID",
    authCode:         "Auth Code",
    provider:         "Provider",
    processedAt:      "Processed At",
    notYet:           "Not yet",
    originalCopy:     "Original / Copy",
    language:         "Language",
    medium:           "Medium",
    pageInfo:         "Page",

    // Financial Summary
    subtotal:         "Subtotal",
    totalDiscount:    "Total Discount",
    totalVat:         "VAT",
    vatBreakdown:     "VAT Breakdown",
    withholdingTax:   "Withholding Tax",
    stampDuty:        "Stamp Duty",
    municipalTax:     "Municipal Tax",
    shipping:         "Shipping",
    handling:         "Handling",
    insurance:        "Insurance",
    otherCharges:     "Other Charges",
    rounding:         "Rounding",
    grandTotal:       "Total",
    totalInWords:     "Total in Words",
    amountPaid:       "Amount Paid",
    amountDue:        "Amount Due",
    balance:          "Balance",
    payable:          "Payable",

    // Line items
    lineItems:        "Line Items",
    itemsExtracted:   "items extracted",
    matchedLabel:     "matched",
    pendingReview:    "pending review",
    noLineItems:      "No line items extracted yet",
    noLineItemsHint:  'Click "Process with ML" to extract invoice data',
    colNumber:        "#",
    colCode:          "Code",
    colDescription:   "Description",
    colQuantity:      "Qty",
    colUnit:          "Unit",
    colUnitPrice:     "Price",
    colDiscount:      "Disc.%",
    colNet:           "Net",
    colVatRate:       "VAT%",
    colVatAmount:     "VAT",
    colTotal:         "Total",
    colErpMatch:      "ERP Match",
    totals:           "Totals",

    // Statuses
    matched:          "Matched",
    manual:           "Manual",
    pending:          "Pending",
    failed:           "Failed",
    paid:             "Paid",
    partial:          "Partial",
    overdue:          "Overdue",
    cancelled:        "Cancelled",

    // Match Dialog
    selectProductMatch:"Select Product Match",
    chooseErp:        "Choose the correct ERP code for this line item",
    code:             "Code",
    qty:              "Qty",
    price:            "Price",
    net:              "Net",
    mlSuggestedMatches:"ML Suggested Matches",
    runningMl:        "Running ML matching...",
    mlUnavailable:    "ML matching unavailable. Use search or manual entry.",
    noMlMatches:      "No ML matches found for this product",
    orSearch:         "or search",
    searchProducts:   "Search Products",
    searchPlaceholder:"Search ERP code or description...",
    searching:        "Searching...",
    noResultsFor:     "No results for",
    orEnterManually:  "or enter manually",
    enterErpManually: "Enter ERP Code Manually",
    manualEntry:      "Manual Entry",
    erpCodePlaceholder:"ERP code...",
    confirm:          "Confirm",
    enterErp:         "Enter an ERP code",

    // Delete Dialog
    deleteTitle:      "Delete Invoice",
    deleteWarning1:   "This will permanently delete invoice",
    deleteWarning2:   "and all its line items. This action cannot be undone.",
    cancel:           "Cancel",

    // Misc
    notAvailable:     "N/A",
    dash:             "—",
  },
  el: {
    // Header
    invoiceDetails:   "Λεπτομέρειες Τιμολογίου",
    creditNote:       "Πιστωτικό Τιμολόγιο",
    cmrDetails:       "Λεπτομέρειες CMR",
    dispatchNote:     "Δελτίο Αποστολής",
    backToInvoices:   "Επιστροφή στα Τιμολόγια",
    invoiceNotFound:  "Δεν βρέθηκε τιμολόγιο",
    previewPdf:       "Προεπισκόπηση PDF",
    hidePdf:          "Απόκρυψη PDF",
    processWithMl:    "Επεξεργασία με ML",
    reprocess:        "Επανεπεξεργασία",
    deleteInvoice:    "Διαγραφή τιμολογίου",
    download:         "Λήψη",
    originalPdf:      "Πρωτότυπο PDF Τιμολογίου",
    loadingPdf:       "Φόρτωση PDF...",
    failedLoadPdf:    "Αποτυχία φόρτωσης PDF",

    // Status banner
    matchingProgress: "Πρόοδος Ταυτοποίησης",
    submitForApproval:"Υποβολή για Έγκριση",
    pushToOptimusDb:  "Αποστολή στο OptimusDB",
    pushToErp:        "Αποστολή στο ERP",
    approvalHistory:  "Ιστορικό Εγκρίσεων",
    pleaseWait:       "Παρακαλώ περιμένετε όσο επεξεργαζόμαστε το έγγραφο",
    stillWorking:     "Επεξεργασία σε εξέλιξη — τα σύνθετα έγγραφα παίρνουν χρόνο...",
    dualPassOcr:      "Το διπλό πέρασμα OCR σε σαρωμένα έγγραφα διαρκεί 2-3 λεπτά...",
    downloadingLang:  "Πρώτη φορά: γίνεται λήψη γλωσσικών δεδομένων OCR (~15MB)...",

    // Non-invoice banner
    notAnInvoiceTitle:"Αυτό το έγγραφο δεν είναι τιμολόγιο",
    notAnInvoiceBody: "Ταξινομήθηκε ως διαφορετικός τύπος εγγράφου, οπότε δεν εξήχθησαν πεδία τιμολογίου.",
    classifiedAs:     "Ταξινομήθηκε ως",
    overrideHint:     "Αν είναι λάθος, κάντε επανεπεξεργασία ή αλλάξτε τον τύπο εγγράφου.",

    // Card titles
    issuer:           "Εκδότης",
    recipient:        "Παραλήπτης",
    invoice:          "Τιμολόγιο",
    financialSummary: "Οικονομική Σύνοψη",
    additionalFields: "Επιπρόσθετα Πεδία",
    references:       "Αναφορές",
    addressSection:   "Διεύθυνση",
    contactSection:   "Επικοινωνία",
    bankingSection:   "Τραπεζικά",
    registrationSection: "Στοιχεία Μητρώου",

    // Issuer/Recipient fields
    name:             "Επωνυμία",
    tradeName:        "Διακριτικός Τίτλος",
    legalForm:        "Νομική Μορφή",
    tagline:          "Σλόγκαν",
    vatNumber:        "ΑΦΜ",
    taxId:            "Φορολογικό ID",
    registrationNumber:"Α.Μ. ΓΕΜΗ",
    withholdingTaxFile:"Αρχείο Παρακράτησης",
    doy:              "ΔΟΥ",
    gemi:             "ΓΕΜΗ",
    profession:       "Δραστηριότητα",
    manager:          "Διαχειριστής",
    branch:           "Υποκατάστημα",
    contactPerson:    "Επικοινωνία",
    customerNumber:   "Κωδικός Πελάτη",
    address:          "Διεύθυνση",
    street:           "Οδός",
    building:         "Κτίριο",
    floor:            "Όροφος",
    city:             "Πόλη",
    region:           "Νομός",
    postCode:         "Τ.Κ.",
    country:          "Χώρα",
    phone:            "Τηλέφωνο",
    fax:              "Φαξ",
    email:            "Email",
    website:          "Ιστοσελίδα",
    iban:             "IBAN",
    swift:            "SWIFT / BIC",
    bank:             "Τράπεζα",
    accountName:      "Όνομα Λογαριασμού",

    // Invoice metadata
    number:           "Αριθμός",
    date:             "Ημερομηνία",
    dueDate:          "Καταληκτική Ημ/νία",
    orderNumber:      "Αρ. Παραγγελίας",
    purchaseOrder:    "Εντολή Αγοράς",
    contractNumber:   "Σύμβαση",
    quoteNumber:      "Προσφορά",
    previousInvoice:  "Προηγούμενο Τιμολόγιο",
    deliveryNote:     "Δελτίο Αποστολής",
    servicePeriod:    "Περίοδος Υπηρεσίας",
    currency:         "Νόμισμα",
    exchangeRate:     "Συναλλ. Ισοτιμία",
    paymentMethod:    "Τρόπος Πληρωμής",
    paymentStatus:    "Κατάσταση Πληρωμής",
    paymentDate:      "Ημ/νία Πληρωμής",
    mark:             "ΜΑΡΚ",
    uid:              "UID",
    authCode:         "Κωδικός Αυθεντικοποίησης",
    provider:         "Πάροχος",
    processedAt:      "Ώρα Επεξεργασίας",
    notYet:           "Όχι ακόμα",
    originalCopy:     "Πρωτότυπο / Αντίγραφο",
    language:         "Γλώσσα",
    medium:           "Μέσο",
    pageInfo:         "Σελίδα",

    // Financial Summary
    subtotal:         "Υποσύνολο",
    totalDiscount:    "Σύνολο Έκπτωσης",
    totalVat:         "ΦΠΑ",
    vatBreakdown:     "Ανάλυση ΦΠΑ",
    withholdingTax:   "Παρακράτηση",
    stampDuty:        "Χαρτόσημο",
    municipalTax:     "Δημοτικός Φόρος",
    shipping:         "Μεταφορικά",
    handling:         "Διαχείριση",
    insurance:        "Ασφάλιστρα",
    otherCharges:     "Λοιπές Επιβαρύνσεις",
    rounding:         "Στρογγυλοποίηση",
    grandTotal:       "Σύνολο",
    totalInWords:     "Σύνολο Ολογράφως",
    amountPaid:       "Καταβληθέν Ποσό",
    amountDue:        "Οφειλόμενο Ποσό",
    balance:          "Υπόλοιπο",
    payable:          "Πληρωτέο",

    // Line items
    lineItems:        "Γραμμές",
    itemsExtracted:   "γραμμές εξήχθησαν",
    matchedLabel:     "ταυτοποιημένες",
    pendingReview:    "σε αναμονή ελέγχου",
    noLineItems:      "Δεν εξήχθησαν γραμμές ακόμα",
    noLineItemsHint:  'Πάτησε "Επεξεργασία με ML" για εξαγωγή δεδομένων',
    colNumber:        "Α/Α",
    colCode:          "Κωδ.",
    colDescription:   "Περιγραφή",
    colQuantity:      "Ποσ.",
    colUnit:          "Μ.Μ.",
    colUnitPrice:     "Τιμή",
    colDiscount:      "Έκπτ.%",
    colNet:           "Αξία",
    colVatRate:       "ΦΠΑ%",
    colVatAmount:     "ΦΠΑ",
    colTotal:         "Τελ. Αξία",
    colErpMatch:      "ERP Match",
    totals:           "Σύνολα",

    // Statuses
    matched:          "Ταυτοπ.",
    manual:           "Χειροκίν.",
    pending:          "Εκκρεμεί",
    failed:           "Απέτυχε",
    paid:             "Εξοφλημένο",
    partial:          "Μερική",
    overdue:          "Εκπρόθεσμο",
    cancelled:        "Ακυρωμένο",

    // Match Dialog
    selectProductMatch:"Επιλογή Αντιστοιχίας Προϊόντος",
    chooseErp:        "Διάλεξε τον σωστό κωδικό ERP για αυτή τη γραμμή",
    code:             "Κωδικός",
    qty:              "Ποσότητα",
    price:            "Τιμή",
    net:              "Αξία",
    mlSuggestedMatches:"Προτεινόμενες ML Αντιστοιχίες",
    runningMl:        "Εκτέλεση ML matching...",
    mlUnavailable:    "Το ML matching δεν είναι διαθέσιμο. Χρησιμοποίησε αναζήτηση ή χειροκίνητη εισαγωγή.",
    noMlMatches:      "Δεν βρέθηκαν ML αντιστοιχίες για αυτό το προϊόν",
    orSearch:         "ή αναζήτηση",
    searchProducts:   "Αναζήτηση Προϊόντων",
    searchPlaceholder:"Αναζήτηση κωδικού ERP ή περιγραφής...",
    searching:        "Αναζήτηση...",
    noResultsFor:     "Καμία εγγραφή για",
    orEnterManually:  "ή χειροκίνητη εισαγωγή",
    enterErpManually: "Χειροκίνητη Εισαγωγή ERP Κωδικού",
    manualEntry:      "Χειροκίνητη Εισαγωγή",
    erpCodePlaceholder:"Κωδικός ERP...",
    confirm:          "Επιβεβαίωση",
    enterErp:         "Εισήγαγε έναν κωδικό ERP",

    // Delete Dialog
    deleteTitle:      "Διαγραφή Τιμολογίου",
    deleteWarning1:   "Αυτό θα διαγράψει μόνιμα το τιμολόγιο",
    deleteWarning2:   "και όλες τις γραμμές του. Η ενέργεια δεν αναιρείται.",
    cancel:           "Ακύρωση",

    // Misc
    notAvailable:     "Μ/Δ",
    dash:             "—",
  },
} as const;

type TKey = keyof typeof TRANSLATIONS.en;

/** Hook returns (lang, setLang, t) — t is a memoized lookup function. */
function useLanguage(): {
  lang: Language;
  setLang: (l: Language) => void;
  t: (key: TKey) => string;
} {
  const [lang, setLangState] = useState<Language>(() => {
    if (typeof window === "undefined") return "en";
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    return stored === "el" || stored === "en" ? stored : "en";
  });

  const setLang = useCallback((l: Language) => {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, l);
    } catch {}
  }, []);

  const t = useCallback(
      (key: TKey) => TRANSLATIONS[lang][key] ?? TRANSLATIONS.en[key] ?? key,
      [lang]
  );

  return { lang, setLang, t };
}

/** Compact pill toggle: [ EN | ΕΛ ] */
function LanguageToggle({
                          lang,
                          setLang,
                        }: {
  lang: Language;
  setLang: (l: Language) => void;
}) {
  return (
      <div
          className="flex items-center rounded-lg border border-slate-200 bg-white overflow-hidden"
          title="Language"
      >
        <Languages className="h-3.5 w-3.5 text-slate-400 ml-2" />
        {(["en", "el"] as const).map(l => (
            <button
                key={l}
                onClick={() => setLang(l)}
                className={`h-8 px-2.5 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
                    lang === l
                        ? "bg-blue-600 text-white"
                        : "text-slate-500 hover:bg-slate-50"
                }`}
            >
              {l === "en" ? "EN" : "ΕΛ"}
            </button>
        ))}
      </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// FORMATTERS
// ═════════════════════════════════════════════════════════════════════════════

/** Format a number-like value with 2 decimals. Returns "—" if null/empty/NaN. */
const fmt = (n: number | string | null | undefined) => {
  if (n == null || n === "") return "—";
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(num)) return "—";
  return num.toLocaleString("el-GR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

/** Money formatter — returns "—" alone (no currency symbol) for null. */
const money = (
    n: number | string | null | undefined,
    symbol: string = "€"
) => {
  if (n == null || n === "") return "—";
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(num)) return "—";
  return `${symbol}${num.toLocaleString("el-GR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const fmtDate = (d: string | Date | null | undefined, lang: Language) => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return typeof d === "string" ? d : "—";
  return date.toLocaleDateString(lang === "el" ? "el-GR" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const fmtDateTime = (d: string | Date | null | undefined, lang: Language) => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return (
      date.toLocaleDateString(lang === "el" ? "el-GR" : "en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }) +
      " " +
      date.toLocaleTimeString(lang === "el" ? "el-GR" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })
  );
};

// ═════════════════════════════════════════════════════════════════════════════
// PROCESSING STAGES (time-based, no DB dependency)
// ═════════════════════════════════════════════════════════════════════════════

const STAGE_TIMINGS = [
  { after: 0,   label: "Preparing document...",    icon: "📄", pct: 5  },
  { after: 2,   label: "Extracting text / OCR...", icon: "🔍", pct: 10 },
  { after: 8,   label: "OCR pass 1 (text quality)...", icon: "📸", pct: 25 },
  { after: 40,  label: "OCR pass 2 (table structure)...", icon: "📊", pct: 45 },
  { after: 70,  label: "Classifying document type...", icon: "🏷️", pct: 55 },
  { after: 80,  label: "Extracting fields & data...", icon: "📋", pct: 70 },
  { after: 100, label: "Matching products...",     icon: "🔗", pct: 85 },
  { after: 120, label: "Almost done...",           icon: "⏳", pct: 95 },
];

// ═════════════════════════════════════════════════════════════════════════════
// REUSABLE FIELD COMPONENTS (clean null handling)
// ═════════════════════════════════════════════════════════════════════════════

/** A label + value pair with em-dash fallback. */
function Field({
                 label,
                 value,
                 mono = false,
                 emphasis = false,
                 wide = false,
                 className = "",
               }: {
  label: string;
  value: any;
  mono?: boolean;
  emphasis?: boolean;
  wide?: boolean;
  className?: string;
}) {
  const hasValue = value != null && value !== "" && value !== "—";
  return (
      <div className={`${wide ? "col-span-2" : ""} ${className}`}>
        <p className="text-[9px] text-slate-400 uppercase tracking-wider font-semibold mb-0.5">
          {label}
        </p>
        <p
            className={`text-xs ${mono ? "font-mono text-[11px]" : ""} ${
                emphasis
                    ? "text-sm font-semibold text-slate-900"
                    : hasValue
                        ? "font-medium text-slate-700"
                        : "text-slate-300"
            } ${wide ? "break-all" : ""}`}
        >
          {hasValue ? String(value) : "—"}
        </p>
      </div>
  );
}

/** A subsection within a card — heading + grid of fields. */
function FieldGroup({
                      title,
                      children,
                    }: {
  title: string;
  children: React.ReactNode;
}) {
  return (
      <div className="space-y-2 mt-3 pt-3 border-t border-slate-100">
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
          {title}
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">{children}</div>
      </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// STATUS BADGE
// ═════════════════════════════════════════════════════════════════════════════

function StatusBadge({
                       status,
                       confidence,
                       t,
                     }: {
  status: string;
  confidence?: string | null;
  t: (key: TKey) => string;
}) {
  const cfg: Record<
      string,
      { bg: string; text: string; border: string; labelKey: TKey }
  > = {
    matched: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", labelKey: "matched" },
    manual:  { bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200",    labelKey: "manual"  },
    pending: { bg: "bg-amber-50",   text: "text-amber-600",   border: "border-amber-200",   labelKey: "pending" },
    failed:  { bg: "bg-red-50",     text: "text-red-600",     border: "border-red-200",     labelKey: "failed"  },
  };
  const c = cfg[status] || cfg.pending;
  return (
      <div className="flex items-center gap-1.5 justify-center">
      <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${c.bg} ${c.text} ${c.border}`}
      >
        {t(c.labelKey)}
      </span>
        {confidence && (
            <span className="text-[10px] font-mono text-slate-400">
          {confidence}%
        </span>
        )}
      </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═════════════════════════════════════════════════════════════════════════════

export default function InvoiceDetail() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const { lang, setLang, t } = useLanguage();

  const [selectedLineItem, setSelectedLineItem] = useState<any>(null);
  const [showMatchDialog, setShowMatchDialog] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);
  const [manualErpCode, setManualErpCode] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [pdfScale, setPdfScale] = useState(100);
  const [showDebug, setShowDebug] = useState(false);

// Poll while the invoice is queued/processing so the banner shows live worker
  // progress. We can't read `data` before the query is defined, so the interval
  // is computed inside the options callback against the freshly-fetched row.
  const { data, isLoading, refetch } = trpc.invoices.getById.useQuery(
      { id: Number(id) },
      {
        refetchInterval: (query) => {
          const st = (query.state.data as any)?.invoice?.status;
          return st === "queued" || st === "processing" ? 2000 : false;
        },
      }
  );
  const processMutation = trpc.invoices.process.useMutation();

  // True while the worker is actively handling this invoice (drives the banner).
  const liveStatus = (data?.invoice as any)?.status as string | undefined;
  const isProcessing = liveStatus === "queued" || liveStatus === "processing";

  // Elapsed time since the worker started (real, from startedAt) — for display.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isProcessing) return;
    // re-render every second so the elapsed clock advances
    const tm = setInterval(() => forceTick(t => t + 1), 1000);
    return () => clearInterval(tm);
  }, [isProcessing]);

  const confirmMatchMutation  = trpc.products.confirmMatch.useMutation();
  const createInvoiceMutation = trpc.softone.createInvoice.useMutation();
  const pushOptimusMut        = trpc.optimusDb.pushInvoice.useMutation();
  const submitApprovalMut     = trpc.approvals.submit.useMutation();
  const { data: approvalList, refetch: refetchApprovals } =
      trpc.approvals.byInvoice.useQuery({ invoiceId: Number(id) }, { enabled: !!id });
  const deleteMutation        = trpc.invoices.delete.useMutation();

  const pdfQuery = trpc.invoices.getPdf.useQuery(
      { id: Number(id) },
      { enabled: showPreview }
  );
  const pdfDataUrl = useMemo(() => {
    if (pdfQuery.data?.base64) return `data:application/pdf;base64,${pdfQuery.data.base64}`;
    return null;
  }, [pdfQuery.data?.base64]);

  const extractedData = data?.invoice?.extractedData
      ? JSON.parse(data.invoice.extractedData)
      : {};
  const docType =
      extractedData.documentType ||
      (data?.invoice as any)?.documentType ||
      "invoice";

  // Document type styling
  const docTypeLabels: Record<string, { label: string; color: string; bg: string }> = {
    invoice:       { label: lang === "el" ? "Τιμολόγιο"        : "Invoice",          color: "text-blue-700",    bg: "bg-blue-50 border-blue-200" },
    credit_note:   { label: lang === "el" ? "Πιστωτικό"         : "Credit Note",      color: "text-purple-700",  bg: "bg-purple-50 border-purple-200" },
    cmr:           { label: "CMR",                                                   color: "text-orange-700",  bg: "bg-orange-50 border-orange-200" },
    dispatch_note: { label: lang === "el" ? "Δελτίο Αποστολής"  : "Dispatch",         color: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
    proforma:      { label: lang === "el" ? "Προτιμολόγιο"      : "Proforma",         color: "text-amber-700",   bg: "bg-amber-50 border-amber-200" },
    receipt:       { label: lang === "el" ? "Απόδειξη"          : "Receipt",          color: "text-teal-700",    bg: "bg-teal-50 border-teal-200" },
    order:         { label: lang === "el" ? "Παραγγελία"        : "Purchase Order",   color: "text-indigo-700",  bg: "bg-indigo-50 border-indigo-200" },
    statement:     { label: lang === "el" ? "Κατάσταση Λογ/σμού": "Statement",        color: "text-cyan-700",    bg: "bg-cyan-50 border-cyan-200" },
    cheque:        { label: lang === "el" ? "Επιταγή"           : "Cheque",           color: "text-rose-700",    bg: "bg-rose-50 border-rose-200" },
    unknown:       { label: lang === "el" ? "Άγνωστο"           : "Unknown",          color: "text-slate-600",   bg: "bg-slate-100 border-slate-200" },
  };
  const dtLabel = docTypeLabels[docType] || docTypeLabels.invoice;

  // Doc types that have their OWN dedicated full view (invoice/credit_note share
  // the rich invoice view; cmr/dispatch_note render their own sections). Anything
  // NOT in this set is a non-invoice that fell through to the generic view — we
  // show an explanatory banner instead of a silent empty form.
  const INVOICE_LIKE_TYPES = new Set(["invoice", "credit_note", "cmr", "dispatch_note"]);
  const isNonInvoiceDoc = !INVOICE_LIKE_TYPES.has(docType);

  const matchQuery = trpc.products.match.useQuery(
      {
        supplierName:  extractedData.supplierName || "Unknown",
        supplierCode:  selectedLineItem?.supplierCode || "",
        description:   selectedLineItem?.description || "",
        topN: 5,
      },
      { enabled: !!selectedLineItem && showMatchDialog }
  );
  const searchResults = trpc.products.search.useQuery(
      { query: searchQuery },
      { enabled: isSearching && searchQuery.length >= 2 }
  );

  useEffect(() => {
    if (!showMatchDialog) {
      setShowManualInput(false);
      setManualErpCode("");
      setSearchQuery("");
      setIsSearching(false);
    }
  }, [showMatchDialog]);

  const handleProcessInvoice = async () => {
    try {
      const result = await processMutation.mutateAsync({ invoiceId: Number(id) });
      toast.success("Queued for processing", {
        description: result.message || "The worker will process this shortly",
      });
      // Kick the poll immediately so the banner appears without waiting 2s.
      refetch();
    } catch (error: any) {
      toast.error("Failed to queue", { description: error.message });
    }
  };

  const handleSelectMatch = async (
      lineItem: any,
      match: { erpCode: string; confidence: number; method?: string }
  ) => {
    try {
      const result = await confirmMatchMutation.mutateAsync({
        lineItemId:   lineItem.id,
        erpCode:      match.erpCode,
        supplierName: extractedData.supplierName || "Unknown",
        supplierCode: lineItem.supplierCode,
        description:  lineItem.description,
        confidence:   match.confidence.toString(),
      });
      toast.success("Match Confirmed", {
        description: result.message || `${lineItem.supplierCode} → ${match.erpCode}`,
      });
      if (result.pattern)
        toast.success("Rule Learned!", {
          description: `${result.pattern.type} pattern at ${result.pattern.confidence}%`,
        });
      setShowMatchDialog(false);
      setSelectedLineItem(null);
      refetch();
    } catch (error: any) {
      toast.error("Failed", { description: error.message });
    }
  };

  const handleManualConfirm = async (lineItem: any) => {
    if (!manualErpCode.trim()) {
      toast.error(t("enterErp"));
      return;
    }
    await handleSelectMatch(lineItem, {
      erpCode:    manualErpCode.trim(),
      confidence: 100,
      method:     "manual",
    });
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync({ id: Number(id) });
      toast.success("Invoice deleted");
      setLocation("/invoices");
    } catch (error: any) {
      toast.error("Delete failed", { description: error.message });
    }
  };

  // Page title
  const pageTitle =
      docType === "cmr"           ? t("cmrDetails")    :
          docType === "dispatch_note" ? t("dispatchNote")  :
              docType === "credit_note"   ? t("creditNote")    :
                  t("invoiceDetails");

  // ─────────────────────────────────────────────────────────────────────────
  // EARLY RETURNS
  // ─────────────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
        <DashboardLayout>
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-600 border-t-transparent" />
          </div>
        </DashboardLayout>
    );
  }

  if (!data) {
    return (
        <DashboardLayout>
          <div className="text-center py-20">
            <p className="text-base text-slate-600">{t("invoiceNotFound")}</p>
            <Button className="mt-4" variant="outline" onClick={() => setLocation("/invoices")}>
              {t("backToInvoices")}
            </Button>
          </div>
        </DashboardLayout>
    );
  }

  const { invoice, lineItems } = data;
  const matchedCount =
      lineItems?.filter((i: any) => i.matchStatus === "matched" || i.matchStatus === "manual").length || 0;
  const totalCount   = lineItems?.length || 0;
  const matchProgress = totalCount > 0 ? (matchedCount / totalCount) * 100 : 0;
  const mlMatches = matchQuery.data?.matches || [];

  const getMethodLabel = (m: string) =>
      ({
        exact:   "Exact historical",
        fuzzy:   "Fuzzy match",
        tfidf:   "Description similarity",
        pattern: "Learned rule",
      })[m] || m;
  const getConfBadge = (c: number) => {
    if (c >= 90) return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">{c}%</span>;
    if (c >= 70) return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">{c}%</span>;
    return       <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{c}%</span>;
  };

  const statusColors: Record<string, string> = {
    completed:     "bg-emerald-50 text-emerald-700 border-emerald-200",
    failed:        "bg-red-50 text-red-700 border-red-200",
    processing:    "bg-blue-50 text-blue-700 border-blue-200",
    review_needed: "bg-amber-50 text-amber-700 border-amber-200",
    pending:       "bg-slate-50 text-slate-600 border-slate-200",
  };

  // Aggregate totals from line items
  const sumNet   = lineItems?.reduce((s: number, i: any) => s + (parseFloat(i.netAmount)   || 0), 0) || 0;
  const sumVat   = lineItems?.reduce((s: number, i: any) => s + (parseFloat(i.vatAmount)   || 0), 0) || 0;
  const sumTotal = lineItems?.reduce((s: number, i: any) => s + (parseFloat(i.totalWithVat)|| 0), 0) || 0;

  // Dispatch note items (untouched)
  const dispatchItems = extractedData.items || [];
  const dispatchTotalQty = dispatchItems.reduce(
      (s: number, i: any) => s + (parseFloat(i.quantity) || 0), 0);
  const dispatchTotalAmt = dispatchItems.reduce(
      (s: number, i: any) => s + (parseFloat(i.totalPrice || i.amount || i.netAmount) || 0), 0);

  // ─────────────────────────────────────────────────────────────────────────
  // RICH FIELD EXTRACTION (issuer / recipient / invoice metadata)
  // ─────────────────────────────────────────────────────────────────────────

  // Issuer — merged from nested issuer object + legacy flat fields
  const issuer = {
    name:                extractedData.issuer?.name                ?? extractedData.supplierName,
    tradeName:           extractedData.issuer?.tradeName,
    legalForm:           extractedData.issuer?.legalForm,
    tagline:             extractedData.issuer?.tagline,
    vatNumber:           extractedData.issuer?.vatNumber           ?? extractedData.supplierVatNumber,
    taxId:               extractedData.issuer?.taxId,
    registrationNumber:  extractedData.issuer?.registrationNumber,
    withholdingTaxFile:  extractedData.issuer?.withholdingTaxFile,
    doy:                 extractedData.issuer?.doy,
    gemi:                extractedData.issuer?.gemi,
    profession:          extractedData.issuer?.profession,
    manager:             extractedData.issuer?.manager,
    address:             extractedData.issuer?.address?.street     ?? extractedData.issuer?.address ?? extractedData.supplierAddress,
    building:            extractedData.issuer?.address?.building,
    floor:               extractedData.issuer?.address?.floor,
    city:                extractedData.issuer?.address?.city       ?? extractedData.issuer?.city,
    region:              extractedData.issuer?.address?.region     ?? extractedData.issuer?.region,
    postCode:            extractedData.issuer?.address?.postCode   ?? extractedData.issuer?.postCode,
    country:             extractedData.issuer?.address?.country    ?? extractedData.issuer?.country,
    phone:               extractedData.issuer?.contact?.phone      ?? extractedData.issuer?.phone,
    fax:                 extractedData.issuer?.contact?.fax        ?? extractedData.issuer?.fax,
    email:               extractedData.issuer?.contact?.email      ?? extractedData.issuer?.email,
    website:             extractedData.issuer?.contact?.website    ?? extractedData.issuer?.website,
    iban:                extractedData.issuer?.banking?.iban       ?? extractedData.issuer?.iban,
    swift:               extractedData.issuer?.banking?.bic        ?? extractedData.issuer?.swift,
    bank:                extractedData.issuer?.banking?.bankName   ?? extractedData.issuer?.bank,
    accountName:         extractedData.issuer?.banking?.accountName,
  };

  // Recipient — same pattern
  const recipient = {
    name:                extractedData.recipient?.name             ?? extractedData.customerName,
    legalForm:           extractedData.recipient?.legalForm,
    contactPerson:       extractedData.recipient?.contactPerson,
    customerNumber:      extractedData.recipient?.customerNumber,
    vatNumber:           extractedData.recipient?.vatNumber        ?? extractedData.customerVatNumber,
    taxId:               extractedData.recipient?.taxId,
    registrationNumber:  extractedData.recipient?.registrationNumber,
    doy:                 extractedData.recipient?.doy,
    profession:          extractedData.recipient?.profession,
    manager:             extractedData.recipient?.manager,
    branch:              extractedData.recipient?.branch,
    address:             extractedData.recipient?.address?.street  ?? extractedData.recipient?.address,
    building:            extractedData.recipient?.address?.building,
    city:                extractedData.recipient?.address?.city    ?? extractedData.recipient?.city,
    region:              extractedData.recipient?.address?.region  ?? extractedData.recipient?.region,
    postCode:            extractedData.recipient?.address?.postCode?? extractedData.recipient?.postCode,
    country:             extractedData.recipient?.address?.country ?? extractedData.recipient?.country,
    phone:               extractedData.recipient?.contact?.phone   ?? extractedData.recipient?.phone,
    fax:                 extractedData.recipient?.contact?.fax,
    email:               extractedData.recipient?.contact?.email   ?? extractedData.recipient?.email,
  };

  // Document references
  const refs = extractedData.document?.references ?? extractedData.references ?? {};

  // Currency
  const currencyCode   = extractedData.currency?.code   ?? extractedData.currency ?? "EUR";
  const currencySymbol = extractedData.currency?.symbol ?? (currencyCode === "EUR" ? "€" : currencyCode);
  const exchangeRate   = extractedData.currency?.exchangeRate;

  // Payment
  const payment = {
    method:    extractedData.payment?.method        ?? extractedData.paymentMethod,
    status:    extractedData.payment?.status,
    date:      extractedData.payment?.date          ?? extractedData.paymentDate,
    dueDate:   extractedData.payment?.dueDate       ?? extractedData.dueDate,
    terms:     extractedData.payment?.terms,
    bankAccount: extractedData.payment?.bankAccount,
    reference: extractedData.payment?.reference,
  };

  // Helper to check if any field in a group has a value
  const hasAny = (obj: any, keys: string[]) =>
      keys.some(k => obj?.[k] != null && obj[k] !== "");

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
      <DashboardLayout>
        <div className="space-y-5 max-w-7xl">
          {/* ═══ HEADER ═══ */}
          <div className="flex items-center gap-3">
            <button
                onClick={() => setLocation("/invoices")}
                className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-slate-100 transition-colors border border-slate-200 bg-white"
            >
              <ArrowLeft className="h-4 w-4 text-slate-400" />
            </button>
            <div className="flex-1">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                {pageTitle}
              </h1>
              <p className="text-xs text-slate-400 mt-0.5 flex items-center gap-2 flex-wrap">
                #
                {extractedData.invoiceNumber ||
                    extractedData.cmrNumber ||
                    extractedData.documentNumber ||
                    invoice.invoiceNumber ||
                    "N/A"}{" "}
                ·{" "}
                {issuer.name || extractedData.sender?.name || "Document"}
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${dtLabel.bg} ${dtLabel.color}`}>
                {dtLabel.label}
              </span>
                {extractedData._vlm_engine && (() => {
                  const method   = extractedData._vlm_extraction_method || "unknown";
                  const isNative = method === "native_text";
                  const isOcr    = method === "ocr_image";
                  const label    = isNative ? "📄 Text PDF" : isOcr ? `🔍 ${extractedData._vlm_engine.toUpperCase()}` : `🤖 ${extractedData._vlm_engine.toUpperCase()}`;
                  const style    = isNative
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : isOcr
                          ? "bg-amber-50 text-amber-700 border-amber-200"
                          : "bg-violet-50 text-violet-700 border-violet-200";
                  return (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border flex items-center gap-1 ${style}`}>
                      {label}
                    </span>
                  );
                })()}
              </p>
            </div>

            {/* ─── Status pill ─── */}
            <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full border ${statusColors[invoice.status] || statusColors.pending}`}>
            {invoice.status.replace("_", " ")}
          </span>

            {/* ─── LANGUAGE TOGGLE ─── */}
            <LanguageToggle lang={lang} setLang={setLang} />

            {/* Delete */}
            <button
                onClick={() => setShowDeleteConfirm(true)}
                title={t("deleteInvoice")}
                className="h-8 w-8 rounded-lg flex items-center justify-center border border-slate-200 hover:border-red-300 hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>

            {/* PDF preview toggle */}
            <button
                onClick={() => setShowPreview(!showPreview)}
                title={showPreview ? t("hidePdf") : t("previewPdf")}
                className={`h-8 px-3 rounded-lg flex items-center gap-1.5 border text-xs font-medium transition-colors ${
                    showPreview
                        ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
                        : "border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                }`}
            >
              {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showPreview ? t("hidePdf") : t("previewPdf")}
            </button>

            {/* Process buttons */}
            {!isProcessing &&
                (invoice.status === "pending" ||
                    invoice.status === "failed" ||
                    (invoice.status === "review_needed" && (!lineItems || lineItems.length === 0))) && (
                    <Button
                        onClick={handleProcessInvoice}
                        disabled={processMutation.isPending}
                        size="sm"
                        className="bg-primary hover:bg-primary/90 text-white text-xs h-8"
                    >
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      {t("processWithMl")}
                    </Button>
                )}
            {!isProcessing &&
                invoice.status === "review_needed" &&
                lineItems && lineItems.length > 0 && (
                    <Button
                        onClick={handleProcessInvoice}
                        disabled={processMutation.isPending}
                        size="sm"
                        variant="outline"
                        className="text-xs h-8 border-blue-200 text-blue-700 hover:bg-blue-50"
                    >
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      {t("reprocess")}
                    </Button>
                )}
          </div>

          {/* ═══ NON-INVOICE BANNER ═══
              Shown when the classifier tagged the document as something other
              than an invoice-like type (cheque, statement, receipt, unknown…).
              Explains why no invoice fields were extracted instead of leaving
              the user staring at an empty form. Reads docType / dtLabel /
              confidence that are already computed above — no backend change. */}
          {isNonInvoiceDoc && !isProcessing && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                <div className="h-9 w-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-800">
                    {t("notAnInvoiceTitle")}
                  </p>
                  <p className="text-xs text-amber-700 mt-0.5">
                    {t("notAnInvoiceBody")}
                  </p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="text-[10px] text-amber-600 uppercase tracking-wide font-semibold">
                      {t("classifiedAs")}:
                    </span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${dtLabel.bg} ${dtLabel.color}`}>
                      {dtLabel.label}
                    </span>
                    {(extractedData.confidence != null || extractedData.classificationConfidence != null) && (
                        <span className="text-[10px] font-mono text-amber-500">
                          {extractedData.confidence ?? extractedData.classificationConfidence}%
                        </span>
                    )}
                  </div>
                  <p className="text-[11px] text-amber-500 mt-2">
                    {t("overrideHint")}
                  </p>
                </div>
              </div>
          )}

          {/* ═══ PROCESSING PROGRESS (real worker status) ═══ */}
          {isProcessing && (() => {
            const inv: any = data?.invoice;
            const status: string = inv?.status ?? "queued";
            const progressMsg: string =
                inv?.progress ||
                (status === "queued" ? "Waiting in queue…" : "Processing…");
            const engine: string | null = inv?.engine ?? null;
            const startedAt = inv?.startedAt ? new Date(inv.startedAt).getTime() : null;
            const queuedAt = inv?.queuedAt ? new Date(inv.queuedAt).getTime() : null;
            const retry = Number(inv?.retryCount ?? 0);

            // Real elapsed time: since the worker started (processing) or since
            // it was queued (still waiting). Recomputed each render (1s tick).
            const fromTs = status === "processing" ? startedAt : queuedAt;
            const elapsedSec = fromTs ? Math.max(0, Math.floor((Date.now() - fromTs) / 1000)) : 0;
            const fmtT = (s: number) => {
              const m = Math.floor(s / 60);
              const sec = s % 60;
              return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
            };

            const isQueued = status === "queued";

            return (
                <div className="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5 animate-in slide-in-from-top-2 duration-300">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center">
                        {isQueued ? (
                            <Clock className="h-4 w-4 text-blue-600" />
                        ) : (
                            <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-blue-900">{progressMsg}</p>
                        <p className="text-[11px] text-blue-600 flex items-center gap-1.5 flex-wrap">
                          {isQueued ? "Waiting for a worker" : "Processing in background"}
                          {engine && <span className="text-blue-400">· engine: {engine}</span>}
                          {retry > 1 && <span className="text-amber-500">· attempt {retry}</span>}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-blue-600 font-mono bg-blue-100 px-2.5 py-1 rounded-lg">
                      <Clock className="h-3 w-3" />
                      {isQueued ? `queued ${fmtT(elapsedSec)}` : fmtT(elapsedSec)}
                    </div>
                  </div>

                  {/* Indeterminate bar — we don't fake a percentage. A subtle moving
                    sheen communicates "working" honestly without lying about %. */}
                  <div className="w-full bg-blue-100 rounded-full h-2.5 overflow-hidden relative">
                    <div
                        className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-violet-500"
                        style={{ animation: "optimusIndeterminate 1.4s ease-in-out infinite" }}
                    />
                  </div>

                  <p className="text-[11px] text-blue-500 mt-3 text-center">
                    You can leave this page — processing continues in the background.
                    Track all jobs on the{" "}
                    <button
                        onClick={() => setLocation("/queue")}
                        className="underline font-medium hover:text-blue-700"
                    >
                      Processing Queue
                    </button>{" "}
                    page.
                  </p>

                  <style>{`
                  @keyframes optimusIndeterminate {
                    0%   { transform: translateX(-100%); }
                    100% { transform: translateX(400%); }
                  }
                `}</style>
                </div>
            );
          })()}

          {/* ═══ PDF PREVIEW ═══ */}
          {showPreview && (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-slate-500" />
                    <span className="text-sm font-semibold text-slate-700">{t("originalPdf")}</span>
                    <span className="text-[10px] text-slate-400 font-mono">{pdfQuery.data?.fileName}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => setPdfScale(s => Math.max(50, s - 25))} disabled={pdfScale <= 50}
                            className="h-7 w-7 rounded flex items-center justify-center hover:bg-slate-200 text-slate-500 disabled:opacity-30 transition">
                      <ZoomOut className="h-3.5 w-3.5" />
                    </button>
                    <span className="text-[10px] font-mono text-slate-400 w-8 text-center">{pdfScale}%</span>
                    <button onClick={() => setPdfScale(s => Math.min(200, s + 25))} disabled={pdfScale >= 200}
                            className="h-7 w-7 rounded flex items-center justify-center hover:bg-slate-200 text-slate-500 disabled:opacity-30 transition">
                      <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                    {pdfDataUrl && (
                        <a href={pdfDataUrl} download={pdfQuery.data?.fileName || "invoice.pdf"}
                           className="h-7 px-2 rounded flex items-center gap-1 hover:bg-slate-200 text-slate-500 text-[10px] font-medium transition ml-1">
                          <Download className="h-3.5 w-3.5" /> {t("download")}
                        </a>
                    )}
                    <button onClick={() => setShowPreview(false)}
                            className="h-7 w-7 rounded flex items-center justify-center hover:bg-slate-200 text-slate-400 transition ml-1">
                      ✕
                    </button>
                  </div>
                </div>
                <div className="bg-slate-100 flex items-center justify-center"
                     style={{ height: `${Math.max(400, pdfScale * 5)}px` }}>
                  {pdfQuery.isLoading ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
                        <span className="text-xs text-slate-400">{t("loadingPdf")}</span>
                      </div>
                  ) : pdfQuery.isError ? (
                      <div className="flex flex-col items-center gap-2 text-slate-400">
                        <AlertTriangle className="h-6 w-6" />
                        <span className="text-xs">{t("failedLoadPdf")}</span>
                      </div>
                  ) : pdfDataUrl ? (
                      <iframe src={pdfDataUrl} className="w-full h-full border-0"
                              style={{ transform: `scale(${pdfScale / 100})`, transformOrigin: "top center" }}
                              title="Invoice PDF Preview" />
                  ) : null}
                </div>
              </div>
          )}

          {/* ═══ MATCHING PROGRESS BAR ═══ */}
          {invoice.status === "review_needed" && totalCount > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-semibold text-slate-700">{t("matchingProgress")}</span>
                  <span className="text-xs text-slate-400 tabular-nums font-medium">{matchedCount}/{totalCount}</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500"
                       style={{ width: `${matchProgress}%`, background: "linear-gradient(90deg, #3b82f6, #2563eb)" }} />
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" variant="outline"
                          onClick={async () => {
                            try {
                              await submitApprovalMut.mutateAsync({
                                invoiceId: Number(id),
                                comment: `${matchedCount}/${totalCount} items matched`,
                              });
                              toast.success("Submitted for approval!");
                              refetchApprovals();
                            } catch (e: any) {
                              toast.error("Failed", { description: e.message });
                            }
                          }}
                          disabled={submitApprovalMut.isPending}
                          className="text-xs h-8 shrink-0 gap-1.5 border-blue-200 text-blue-700 hover:bg-blue-50">
                    {submitApprovalMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (
                        <><ShieldCheck className="h-3.5 w-3.5" />{t("submitForApproval")}</>
                    )}
                  </Button>

                  {matchedCount === totalCount && (
                      <>
                        <Button size="sm" variant="outline"
                                onClick={async () => {
                                  try {
                                    const r = await pushOptimusMut.mutateAsync({ invoiceId: Number(id) });
                                    if (r.success) toast.success("Pushed to OptimusDB!", { description: `Entry: ${r.entryId || "OK"}` });
                                    else toast.error("Push failed", { description: r.error });
                                  } catch (e: any) {
                                    toast.error("OptimusDB not configured", { description: e.message });
                                  }
                                }}
                                disabled={pushOptimusMut.isPending}
                                className="text-xs h-8 shrink-0 gap-1.5">
                          {pushOptimusMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (
                              <><Globe className="h-3.5 w-3.5" />{t("pushToOptimusDb")}</>
                          )}
                        </Button>
                        <Button size="sm"
                                onClick={async () => {
                                  try {
                                    const r = await createInvoiceMutation.mutateAsync({ invoiceId: Number(id) });
                                    toast.success("Created in ERP!", { description: r.message });
                                    refetch();
                                  } catch (e: any) {
                                    toast.error("Failed", { description: e.message });
                                  }
                                }}
                                disabled={createInvoiceMutation.isPending}
                                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs h-8 shrink-0">
                          {createInvoiceMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (
                              <><CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />{t("pushToErp")}</>
                          )}
                        </Button>
                      </>
                  )}
                </div>

                {/* Approval timeline */}
                {approvalList && approvalList.length > 0 && (
                    <div className="mt-4 pt-3 border-t border-slate-100">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-2">{t("approvalHistory")}</p>
                      <div className="space-y-1.5">
                        {approvalList.map((a: any) => (
                            <div key={a.id} className="flex items-center gap-2 text-xs">
                              {a.status === "pending"   ? <Clock        className="h-3 w-3 text-amber-500"/>   :
                                  a.status === "approved"  ? <CheckCircle2 className="h-3 w-3 text-emerald-500"/> :
                                      <XCircle      className="h-3 w-3 text-red-500"/>}
                              <span className={`font-medium ${
                                  a.status === "pending"  ? "text-amber-600"  :
                                      a.status === "approved" ? "text-emerald-600" :
                                          "text-red-600"
                              }`}>{a.status}</span>
                              <span className="text-slate-400">Step {a.step}</span>
                              {a.comment && <span className="text-slate-400 italic">— {a.comment}</span>}
                              {a.decidedAt && <span className="text-slate-300 ml-auto">{fmtDateTime(a.decidedAt, lang)}</span>}
                            </div>
                        ))}
                      </div>
                    </div>
                )}
              </div>
          )}

          {/* ═══════ CMR DETAIL VIEW (UNTOUCHED — bilingual by design) ═══════ */}
          {docType === "cmr" && (
              <div className="space-y-4">
                <div className="grid md:grid-cols-3 gap-4">
                  {[
                    { title: "Αποστολέας / Sender",  data: extractedData.sender,   icon: "📦" },
                    { title: "Μεταφορέας / Carrier", data: extractedData.carrier,  icon: "🚛" },
                    { title: "Παραλήπτης / Consignee", data: extractedData.consignee, icon: "🏢" },
                  ].map(party => (
                      <div key={party.title} className="bg-white rounded-xl border border-slate-200 p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-base">{party.icon}</span>
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{party.title}</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-800">{party.data?.name || "—"}</p>
                        {party.data?.address && <p className="text-xs text-slate-500 mt-1">{party.data.address}</p>}
                        {party.data?.country && <p className="text-xs text-slate-400 mt-0.5">Country: {party.data.country}</p>}
                        {party.data?.vehicle && <p className="text-xs text-slate-400 mt-0.5">Vehicle: {party.data.vehicle}</p>}
                      </div>
                  ))}
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="bg-white rounded-xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Routing</p>
                    <div className="space-y-2">
                      <div className="flex items-center gap-3">
                        <span className="text-green-500 text-sm">📍</span>
                        <div>
                          <p className="text-[10px] text-slate-400">Place of Loading</p>
                          <p className="text-sm font-medium text-slate-700">{extractedData.placeOfLoading || "—"}</p>
                        </div>
                      </div>
                      <div className="border-l-2 border-dashed border-slate-200 ml-2 h-4" />
                      <div className="flex items-center gap-3">
                        <span className="text-red-500 text-sm">📍</span>
                        <div>
                          <p className="text-[10px] text-slate-400">Place of Delivery</p>
                          <p className="text-sm font-medium text-slate-700">{extractedData.placeOfDelivery || "—"}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="bg-white rounded-xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Shipment Details</p>
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        ["CMR No.",        extractedData.cmrNumber],
                        ["Date",           extractedData.date],
                        ["Packages",       extractedData.totalPackages],
                        ["Gross Weight",   extractedData.totalGrossWeight ? `${extractedData.totalGrossWeight} kg` : null],
                        ["Volume",         extractedData.totalVolume ? `${extractedData.totalVolume} m³` : null],
                        ["Freight",        extractedData.freightCharges ? `€${extractedData.freightCharges}` : null],
                      ].filter(([, v]) => v).map(([label, value]) => (
                          <div key={label as string}>
                            <p className="text-[10px] text-slate-400">{label}</p>
                            <p className="text-sm font-medium text-slate-700">{value}</p>
                          </div>
                      ))}
                    </div>
                  </div>
                </div>
                {extractedData.goods?.length > 0 && (
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Goods / Εμπορεύματα</span>
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                        <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                          <th className="px-4 py-2 text-left">#</th>
                          <th className="px-4 py-2 text-left">Description</th>
                          <th className="px-4 py-2 text-right">Packages</th>
                          <th className="px-4 py-2 text-right">Weight (kg)</th>
                        </tr>
                        </thead>
                        <tbody>
                        {extractedData.goods.map((g: any, i: number) => (
                            <tr key={i} className="border-t border-slate-100 hover:bg-blue-50/50">
                              <td className="px-4 py-2 text-slate-400 tabular-nums">{i + 1}</td>
                              <td className="px-4 py-2 text-slate-700">{g.description}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{g.packages || "—"}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{g.grossWeight || "—"}</td>
                            </tr>
                        ))}
                        </tbody>
                      </table>
                    </div>
                )}
                {extractedData.instructions && (
                    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                      <p className="text-xs font-semibold text-amber-700 mb-1">Special Instructions</p>
                      <p className="text-sm text-amber-800">{extractedData.instructions}</p>
                    </div>
                )}
              </div>
          )}

          {/* ═══════ DISPATCH NOTE VIEW (UNTOUCHED — bilingual by design) ═══════ */}
          {docType === "dispatch_note" && (
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  {[
                    { title: "Αποστολέας / Sender",   data: extractedData.sender,    icon: "📦" },
                    { title: "Παραλήπτης / Recipient", data: extractedData.recipient, icon: "🏢" },
                  ].map(party => (
                      <div key={party.title} className="bg-white rounded-xl border border-slate-200 p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <span className="text-base">{party.icon}</span>
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{party.title}</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-800">{party.data?.name || "—"}</p>
                        {party.data?.vatNumber  && <p className="text-xs text-slate-500 mt-1">ΑΦΜ: {party.data.vatNumber}</p>}
                        {party.data?.profession && <p className="text-xs text-slate-400 mt-0.5">{party.data.profession}</p>}
                        {party.data?.address    && <p className="text-xs text-slate-400 mt-0.5">{party.data.address}</p>}
                        {party.data?.city       && <p className="text-xs text-slate-400 mt-0.5">{party.data.city}</p>}
                        {party.data?.doy        && <p className="text-xs text-slate-400 mt-0.5">ΔΟΥ: {party.data.doy}</p>}
                        {party.data?.phone      && <p className="text-xs text-slate-400 mt-0.5">Τηλ: {party.data.phone}</p>}
                        {party.data?.email      && <p className="text-xs text-slate-400 mt-0.5">{party.data.email}</p>}
                      </div>
                  ))}
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Dispatch Details</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      ["Document #",      extractedData.documentNumber],
                      ["Series",          extractedData.series],
                      ["Date",            extractedData.date],
                      ["Purpose",         extractedData.purpose],
                      ["Transport",       extractedData.transportMethod],
                      ["Vehicle",         extractedData.vehicleNumber],
                      ["Loading Place",   extractedData.loadingPlace],
                      ["Destination",     extractedData.destinationPlace],
                      ["Delivery Address",extractedData.deliveryAddress],
                      ["Payment Method",  extractedData.paymentMethod],
                      ["Total Qty",       extractedData.totalQuantity],
                      ["Total Amount",    extractedData.totalAmount ? fmt(extractedData.totalAmount) : null],
                    ].filter(([, v]) => v).map(([label, value]) => (
                        <div key={label as string}>
                          <p className="text-[10px] text-slate-400">{label}</p>
                          <p className="text-sm font-medium text-slate-700">{value}</p>
                        </div>
                    ))}
                  </div>
                </div>
                {dispatchItems.length > 0 && (
                    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                      <div className="px-4 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Items / Είδη</span>
                        <span className="text-[10px] text-slate-400">{dispatchItems.length} item{dispatchItems.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                          <thead>
                          <tr style={{ background: "linear-gradient(135deg, #064e3b 0%, #065f46 100%)" }} className="text-white">
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold tracking-wider uppercase w-10 border-r border-emerald-700/30">Α/Α</th>
                            <th className="px-3 py-2.5 text-left text-[10px] font-semibold tracking-wider uppercase w-20 border-r border-emerald-700/30">Κωδικός</th>
                            <th className="px-3 py-2.5 text-left text-[10px] font-semibold tracking-wider uppercase min-w-[200px] border-r border-emerald-700/30">Περιγραφή</th>
                            <th className="px-3 py-2.5 text-right text-[10px] font-semibold tracking-wider uppercase w-16 border-r border-emerald-700/30">Ποσότ.</th>
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold tracking-wider uppercase w-16 border-r border-emerald-700/30">Μ.Μ.</th>
                            <th className="px-3 py-2.5 text-right text-[10px] font-semibold tracking-wider uppercase w-20 border-r border-emerald-700/30">Τιμή (€)</th>
                            <th className="px-3 py-2.5 text-right text-[10px] font-semibold tracking-wider uppercase w-24">Μερικό Σύν.</th>
                          </tr>
                          </thead>
                          <tbody>
                          {dispatchItems.map((item: any, i: number) => (
                              <tr key={i} className={`${i % 2 === 0 ? "bg-white" : "bg-slate-50/60"} hover:bg-emerald-50/50 transition-colors border-l-2 border-l-emerald-300`}>
                                <td className="px-3 py-2.5 text-xs text-slate-400 text-center tabular-nums border-r border-slate-100">{i + 1}</td>
                                <td className="px-3 py-2.5 font-mono text-xs font-bold text-slate-700 border-r border-slate-100">{item.code || "—"}</td>
                                <td className="px-3 py-2.5 text-xs text-slate-800 border-r border-slate-100">{item.description}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums font-medium text-slate-700 border-r border-slate-100">{fmt(item.quantity)}</td>
                                <td className="px-3 py-2.5 text-[11px] text-center text-slate-400 border-r border-slate-100">{item.unit || "—"}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums text-slate-600 border-r border-slate-100">{fmt(item.unitPrice)}</td>
                                <td className="px-3 py-2.5 text-xs text-right tabular-nums font-semibold text-slate-800">{fmt(item.totalPrice || item.amount || item.netAmount)}</td>
                              </tr>
                          ))}
                          </tbody>
                          <tfoot>
                          <tr className="border-t-2 border-slate-300" style={{ background: "linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)" }}>
                            <td colSpan={3} className="px-3 py-3 text-right text-[10px] font-bold text-slate-500 uppercase tracking-wider">Σύνολα</td>
                            <td className="px-3 py-3 text-right text-xs tabular-nums font-bold text-slate-800 border-r border-slate-200">{fmt(dispatchTotalQty)}</td>
                            <td className="border-r border-slate-200" />
                            <td className="border-r border-slate-200" />
                            <td className="px-3 py-3 text-right text-xs tabular-nums font-bold text-slate-900">{fmt(dispatchTotalAmt)}</td>
                          </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                )}
                {extractedData.notes && (
                    <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                      <p className="text-xs font-semibold text-slate-500 mb-1">Notes</p>
                      <p className="text-sm text-slate-700">{extractedData.notes}</p>
                    </div>
                )}
              </div>
          )}

          {/* ═══════ INVOICE / CREDIT NOTE VIEW (REWRITTEN — i18n + expanded fields) ═══════ */}
          {(docType === "invoice" || docType === "credit_note") && (
              <>
                {/* Credit Note Banner */}
                {docType === "credit_note" && (
                    <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 flex items-center gap-3">
                      <div className="h-9 w-9 rounded-lg bg-purple-100 flex items-center justify-center shrink-0">
                        <span className="text-lg">📋</span>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-purple-800">{t("creditNote")}</p>
                        <p className="text-xs text-purple-600 mt-0.5">
                          {extractedData.originalInvoiceNumber && (
                              <>Ref: <span className="font-mono font-bold">{extractedData.originalInvoiceNumber}</span></>
                          )}
                          {extractedData.creditReason && <> · {extractedData.creditReason}</>}
                          {extractedData.isFull && <> · <span className="font-semibold">Full cancellation</span></>}
                        </p>
                      </div>
                    </div>
                )}

                {/* Info Cards — 2x2 */}
                <div className="grid md:grid-cols-2 gap-4">

                  {/* ─── ISSUER ─── */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-7 w-7 rounded-lg bg-slate-100 flex items-center justify-center">
                        <Building2 className="h-3.5 w-3.5 text-slate-500" />
                      </div>
                      <span className="text-sm font-semibold text-slate-800">{t("issuer")}</span>
                      {issuer.country && (
                          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium border border-slate-200">
                        {issuer.country}
                      </span>
                      )}
                    </div>

                    {/* Identity */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                      <Field label={t("name")}          value={issuer.name}      emphasis wide />
                      {issuer.tradeName && <Field label={t("tradeName")} value={issuer.tradeName} wide />}
                      {issuer.legalForm && <Field label={t("legalForm")} value={issuer.legalForm} />}
                      {issuer.profession && <Field label={t("profession")} value={issuer.profession} />}
                      {issuer.tagline && <Field label={t("tagline")} value={issuer.tagline} wide />}
                    </div>

                    {/* Registration */}
                    {hasAny(issuer, ["vatNumber", "taxId", "registrationNumber", "withholdingTaxFile", "doy", "gemi", "manager"]) && (
                        <FieldGroup title={t("registrationSection")}>
                          {issuer.vatNumber          && <Field label={t("vatNumber")}          value={issuer.vatNumber}          mono />}
                          {issuer.taxId              && <Field label={t("taxId")}              value={issuer.taxId}              mono />}
                          {issuer.registrationNumber && <Field label={t("registrationNumber")} value={issuer.registrationNumber} mono />}
                          {issuer.withholdingTaxFile && <Field label={t("withholdingTaxFile")} value={issuer.withholdingTaxFile} mono />}
                          {issuer.doy                && <Field label={t("doy")}                value={issuer.doy} />}
                          {issuer.gemi               && <Field label={t("gemi")}               value={issuer.gemi}               mono />}
                          {issuer.manager            && <Field label={t("manager")}            value={issuer.manager} />}
                        </FieldGroup>
                    )}

                    {/* Address */}
                    {hasAny(issuer, ["address", "building", "floor", "city", "region", "postCode", "country"]) && (
                        <FieldGroup title={t("addressSection")}>
                          {issuer.address  && <Field label={t("street")}   value={issuer.address}  wide />}
                          {issuer.building && <Field label={t("building")} value={issuer.building} />}
                          {issuer.floor    && <Field label={t("floor")}    value={issuer.floor} />}
                          {issuer.city     && <Field label={t("city")}     value={issuer.city} />}
                          {issuer.region   && <Field label={t("region")}   value={issuer.region} />}
                          {issuer.postCode && <Field label={t("postCode")} value={issuer.postCode} />}
                          {issuer.country  && <Field label={t("country")}  value={issuer.country} />}
                        </FieldGroup>
                    )}

                    {/* Contact */}
                    {hasAny(issuer, ["phone", "fax", "email", "website"]) && (
                        <FieldGroup title={t("contactSection")}>
                          {issuer.phone   && <Field label={t("phone")}   value={issuer.phone} />}
                          {issuer.fax     && <Field label={t("fax")}     value={issuer.fax} />}
                          {issuer.email   && <Field label={t("email")}   value={issuer.email} />}
                          {issuer.website && <Field label={t("website")} value={issuer.website} />}
                        </FieldGroup>
                    )}

                    {/* Banking */}
                    {hasAny(issuer, ["iban", "swift", "bank", "accountName"]) && (
                        <FieldGroup title={t("bankingSection")}>
                          {issuer.iban        && <Field label={t("iban")}        value={issuer.iban}        mono wide />}
                          {issuer.swift       && <Field label={t("swift")}       value={issuer.swift}       mono />}
                          {issuer.bank        && <Field label={t("bank")}        value={issuer.bank} />}
                          {issuer.accountName && <Field label={t("accountName")} value={issuer.accountName} />}
                        </FieldGroup>
                    )}
                  </div>

                  {/* ─── INVOICE METADATA ─── */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-7 w-7 rounded-lg bg-slate-100 flex items-center justify-center">
                        <FileText className="h-3.5 w-3.5 text-slate-500" />
                      </div>
                      <span className="text-sm font-semibold text-slate-800">{t("invoice")}</span>
                      {extractedData.document?.originalCopy && (
                          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium border border-blue-200">
                        {extractedData.document.originalCopy}
                      </span>
                      )}
                    </div>

                    {/* Core */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                      <Field label={t("number")} value={extractedData.invoiceNumber || invoice.invoiceNumber} emphasis />
                      <Field label={t("date")}   value={extractedData.invoiceDate} />
                      {payment.dueDate            && <Field label={t("dueDate")}        value={payment.dueDate} />}
                      <Field label={t("currency")}      value={currencyCode} />
                      {exchangeRate                && <Field label={t("exchangeRate")}  value={exchangeRate} mono />}
                      {payment.method              && <Field label={t("paymentMethod")} value={payment.method} />}
                      {payment.status              && <Field label={t("paymentStatus")} value={t(payment.status as TKey) || payment.status} />}
                      {payment.date                && <Field label={t("paymentDate")}   value={fmtDate(payment.date, lang)} />}
                      {extractedData.mark          && <Field label={t("mark")}          value={extractedData.mark} mono wide />}
                      {extractedData.uid           && <Field label={t("uid")}           value={extractedData.uid} mono wide />}
                      {extractedData.authenticationCode && <Field label={t("authCode")} value={extractedData.authenticationCode} mono wide />}
                      {extractedData.provider      && <Field label={t("provider")}      value={extractedData.provider} />}
                      <Field
                          label={t("processedAt")}
                          value={invoice.processedAt ? fmtDateTime(invoice.processedAt, lang) : t("notYet")}
                      />
                    </div>

                    {/* References */}
                    {(extractedData.orderNumber || refs.orderNumber || refs.purchaseOrder || refs.contractNumber || refs.quoteNumber || refs.previousInvoice || refs.deliveryNote) && (
                        <FieldGroup title={t("references")}>
                          {(extractedData.orderNumber || refs.orderNumber) && <Field label={t("orderNumber")}     value={extractedData.orderNumber || refs.orderNumber} mono wide />}
                          {refs.purchaseOrder    && <Field label={t("purchaseOrder")}   value={refs.purchaseOrder}    mono />}
                          {refs.contractNumber   && <Field label={t("contractNumber")}  value={refs.contractNumber}   mono />}
                          {refs.quoteNumber      && <Field label={t("quoteNumber")}     value={refs.quoteNumber}      mono />}
                          {refs.previousInvoice  && <Field label={t("previousInvoice")} value={refs.previousInvoice}  mono />}
                          {refs.deliveryNote     && <Field label={t("deliveryNote")}    value={refs.deliveryNote}     mono />}
                          {refs.servicePeriod?.from && (
                              <Field
                                  label={t("servicePeriod")}
                                  value={`${fmtDate(refs.servicePeriod.from, lang)} → ${fmtDate(refs.servicePeriod.to, lang)}`}
                                  wide
                              />
                          )}
                        </FieldGroup>
                    )}
                  </div>

                  {/* ─── RECIPIENT ─── */}
                  {(recipient.name || recipient.vatNumber) && (
                      <div className="bg-white rounded-xl border border-blue-100 p-5">
                        <div className="flex items-center gap-2 mb-3">
                          <div className="h-7 w-7 rounded-lg bg-blue-50 flex items-center justify-center">
                            <Building2 className="h-3.5 w-3.5 text-blue-500" />
                          </div>
                          <span className="text-sm font-semibold text-slate-800">{t("recipient")}</span>
                          {recipient.country && (
                              <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 font-medium border border-blue-200">
                          {recipient.country}
                        </span>
                          )}
                        </div>

                        {/* Identity */}
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                          <Field label={t("name")} value={recipient.name} emphasis wide />
                          {recipient.legalForm     && <Field label={t("legalForm")}     value={recipient.legalForm} />}
                          {recipient.contactPerson && <Field label={t("contactPerson")} value={recipient.contactPerson} />}
                          {recipient.customerNumber&& <Field label={t("customerNumber")}value={recipient.customerNumber} mono />}
                          {recipient.profession    && <Field label={t("profession")}    value={recipient.profession} />}
                          {recipient.manager       && <Field label={t("manager")}       value={recipient.manager} />}
                          {recipient.branch        && <Field label={t("branch")}        value={recipient.branch} />}
                        </div>

                        {/* Registration */}
                        {hasAny(recipient, ["vatNumber", "taxId", "registrationNumber", "doy"]) && (
                            <FieldGroup title={t("registrationSection")}>
                              {recipient.vatNumber          && <Field label={t("vatNumber")}          value={recipient.vatNumber}          mono />}
                              {recipient.taxId              && <Field label={t("taxId")}              value={recipient.taxId}              mono />}
                              {recipient.registrationNumber && <Field label={t("registrationNumber")} value={recipient.registrationNumber} mono />}
                              {recipient.doy                && <Field label={t("doy")}                value={recipient.doy} />}
                            </FieldGroup>
                        )}

                        {/* Address */}
                        {hasAny(recipient, ["address", "building", "city", "region", "postCode", "country"]) && (
                            <FieldGroup title={t("addressSection")}>
                              {recipient.address  && <Field label={t("street")}   value={recipient.address}  wide />}
                              {recipient.building && <Field label={t("building")} value={recipient.building} />}
                              {recipient.city     && <Field label={t("city")}     value={recipient.city} />}
                              {recipient.region   && <Field label={t("region")}   value={recipient.region} />}
                              {recipient.postCode && <Field label={t("postCode")} value={recipient.postCode} />}
                              {recipient.country  && <Field label={t("country")}  value={recipient.country} />}
                            </FieldGroup>
                        )}

                        {/* Contact */}
                        {hasAny(recipient, ["phone", "fax", "email"]) && (
                            <FieldGroup title={t("contactSection")}>
                              {recipient.phone && <Field label={t("phone")} value={recipient.phone} />}
                              {recipient.fax   && <Field label={t("fax")}   value={recipient.fax} />}
                              {recipient.email && <Field label={t("email")} value={recipient.email} />}
                            </FieldGroup>
                        )}
                      </div>
                  )}

                  {/* ─── ADDITIONAL FIELDS ───
                      Replaces the old Financial Summary card. Walks the full
                      `extractedData` object recursively and shows ANY field
                      that:
                        - is not null/undefined/"" (per user requirement)
                        - is not consumed by any other card (Issuer / Recipient
                          / Invoice / Line Items / myDATA / Dispatch / CMR /
                          totals — see USED_PATHS below)
                        - is not an internal/debug key (starts with "_")
                        - is not an empty object/array
                      Shows leftover information that the model extracted but
                      doesn't fit any existing card. Useful for catching new
                      fields, custom client metadata, or model-specific extras.
                  ─────────────────────────────────────────────────────────── */}
                  <div className="bg-white rounded-xl border border-slate-200 p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <div className="h-7 w-7 rounded-lg bg-indigo-50 flex items-center justify-center">
                        <span className="text-indigo-600 text-xs font-bold">+</span>
                      </div>
                      <span className="text-sm font-semibold text-slate-800">{t("additionalFields")}</span>
                    </div>

                    {(() => {
                      // ── Paths already shown in other cards (blacklist) ──
                      // Format: dot-notation path from the root of extractedData.
                      // Top-level scalars and nested objects/sub-keys all listed.
                      // Generated from a grep of all `extractedData?.X` and
                      // `issuer/recipient/totals?.X` references across the file.
                      const USED_PATHS = new Set<string>([
                        // ── Document-level scalars displayed in Invoice card or as badges ──
                        "documentType", "documentNumber", "invoiceNumber", "invoiceDate",
                        "date", "series", "orderNumber", "currency", "paymentMethod",
                        "paymentDate", "dueDate", "confidence", "classificationConfidence",
                        "totalAmount", "subtotal", "vatAmount", "withholdingTax",
                        "payableAmount",
                        // ── Credit-note / amendment fields ──
                        "creditReason", "originalInvoiceNumber", "isFull",
                        // ── myDATA (Greek tax authority) ──
                        "mark", "uid", "authenticationCode", "provider",
                        // ── Notes (shown in dedicated section if present) ──
                        "notes",
                        // ── Issuer / Recipient nested objects (everything inside
                        //     them is shown via the party cards — block whole subtree) ──
                        "issuer", "recipient", "sender", "supplierName",
                        "supplierVatNumber", "supplierAddress", "customerName",
                        "customerVatNumber",
                        // ── Line items (shown as table) ──
                        "items", "lineItems", "goods",
                        // ── Totals subtree (all sub-keys consumed by us originally,
                        //     but per user request the whole totals object should
                        //     remain hidden — they're shown elsewhere) ──
                        "totals",
                        // ── Dispatch / CMR fields (shown in DispatchView / CmrView) ──
                        "loadingPlace", "destinationPlace", "placeOfLoading",
                        "placeOfDelivery", "deliveryAddress", "transportMethod",
                        "vehicleNumber", "carrier", "consignee", "cmrNumber",
                        "instructions", "purpose", "totalPackages", "totalGrossWeight",
                        "totalVolume", "totalQuantity", "freightCharges",
                        // ── Doc-type wrapper objects (CMR/dispatch nest some data) ──
                        "document", "payment", "references", "rawTextPreview",
                      ]);

                      // Helper: is value "empty" per the user's spec
                      // User said: hide null. We also hide undefined, empty
                      // string, empty array, empty object — these have no
                      // meaningful content to show.
                      const isEmpty = (v: any): boolean => {
                        if (v === null || v === undefined) return true;
                        if (typeof v === "string" && v.trim() === "") return true;
                        if (Array.isArray(v) && v.length === 0) return true;
                        if (typeof v === "object" && Object.keys(v).length === 0) return true;
                        return false;
                      };

                      // Convert a camelCase key to "Camel Case" for display
                      // Example: "purchaseOrderNumber" -> "Purchase Order Number"
                      const humanizeKey = (key: string): string => {
                        // Handle snake_case as well, just in case
                        const normalized = key.replace(/_/g, " ");
                        return normalized
                            // Insert space before capital letters (camelCase boundary)
                            .replace(/([a-z])([A-Z])/g, "$1 $2")
                            // Insert space before digits that follow letters
                            .replace(/([a-zA-Z])(\d)/g, "$1 $2")
                            // Capitalize first letter of each word
                            .replace(/\b\w/g, c => c.toUpperCase());
                      };

                      // Recursive walker: produces a list of { path, label, value }
                      // for every leaf (scalar) in `extractedData` that is NOT
                      // in USED_PATHS and NOT empty/null.
                      type Leaf = { path: string; label: string; value: any };
                      const leaves: Leaf[] = [];

                      const walk = (obj: any, pathParts: string[]) => {
                        if (obj === null || obj === undefined) return;
                        // Arrays of scalars: show as a comma-joined string at the array node.
                        // Arrays of objects: skip (they're usually line-item-shaped tables
                        //                          and either consumed elsewhere or noisy).
                        if (Array.isArray(obj)) {
                          if (obj.length === 0) return;
                          const allScalars = obj.every(
                              x => x === null || ["string", "number", "boolean"].includes(typeof x)
                          );
                          if (allScalars) {
                            const joined = obj.filter(x => !isEmpty(x)).join(", ");
                            if (joined) {
                              const path  = pathParts.join(".");
                              const label = pathParts.map(humanizeKey).join(" → ");
                              leaves.push({ path, label, value: joined });
                            }
                          }
                          // For arrays of objects, do nothing — too risky to display
                          return;
                        }
                        if (typeof obj === "object") {
                          for (const [key, val] of Object.entries(obj)) {
                            // Internal / debug keys: skip whole subtree
                            if (key.startsWith("_")) continue;
                            // Blacklisted by name (full subtree consumed elsewhere)
                            // — applies at any depth so e.g. nested `issuer.address`
                            // doesn't trigger "address" lookup; we check by full path
                            // AND by leaf name for top-level safety.
                            const fullPath = [...pathParts, key].join(".");
                            const topLevelKey = pathParts.length === 0 ? key : null;
                            if (topLevelKey && USED_PATHS.has(topLevelKey)) continue;
                            // Skip if value is empty
                            if (isEmpty(val)) continue;
                            // Recurse into nested objects / arrays
                            if (val !== null && typeof val === "object") {
                              walk(val, [...pathParts, key]);
                              continue;
                            }
                            // Leaf scalar — record it
                            leaves.push({
                              path:  fullPath,
                              label: [...pathParts, key].map(humanizeKey).join(" → "),
                              value: val as any,
                            });
                          }
                          return;
                        }
                        // Scalar at the root (extremely rare in our data shape)
                        if (!isEmpty(obj)) {
                          const path = pathParts.join(".") || "value";
                          leaves.push({ path, label: humanizeKey(path), value: obj });
                        }
                      };

                      walk(extractedData, []);

                      // Format a scalar value for display
                      const formatValue = (v: any): string => {
                        if (typeof v === "boolean") return v ? "✓" : "✗";
                        if (typeof v === "number") {
                          // Heuristic: if it looks like a year/count, no decimal; else 2 decimals
                          if (Number.isInteger(v)) return String(v);
                          return v.toLocaleString(lang === "el" ? "el-GR" : "en-US", {
                            maximumFractionDigits: 4,
                          });
                        }
                        return String(v);
                      };

                      if (leaves.length === 0) {
                        return (
                            <p className="text-xs text-slate-400 italic">
                              {lang === "el"
                                  ? "Δεν υπάρχουν επιπλέον πεδία προς εμφάνιση."
                                  : "No additional fields to display."}
                            </p>
                        );
                      }

                      return (
                          <div className="space-y-1.5">
                            {leaves.map(({ path, label, value }) => (
                                <div key={path} className="flex justify-between gap-3">
                                  <span
                                      className="text-xs text-slate-400 flex-shrink-0 max-w-[55%] break-words"
                                      title={path}
                                  >
                                    {label}
                                  </span>
                                  <span className="text-sm text-slate-700 text-right break-words max-w-[45%]">
                                    {formatValue(value)}
                                  </span>
                                </div>
                            ))}
                          </div>
                      );
                    })()}
                  </div>
                </div>

                {/* ═══════ LINE ITEMS TABLE ═══════ */}
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-800">{t("lineItems")}</h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {totalCount > 0
                            ? `${totalCount} ${t("itemsExtracted")} · ${matchedCount} ${t("matchedLabel")} · ${totalCount - matchedCount} ${t("pendingReview")}`
                            : t("noLineItems")}
                      </p>
                    </div>
                    {totalCount > 0 && (
                        <div className="flex items-center gap-3 text-[10px] text-slate-400">
                          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400 inline-block" /> {t("matched")}</span>
                          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400 inline-block" />   {t("pending")}</span>
                          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-400 inline-block" />     {t("failed")}</span>
                        </div>
                    )}
                  </div>

                  {lineItems && lineItems.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                          <thead>
                          <tr style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)" }} className="text-white">
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold tracking-wider uppercase w-10 border-r border-slate-700/30">{t("colNumber")}</th>
                            <th className="px-3 py-2.5 text-left   text-[10px] font-semibold tracking-wider uppercase w-20 border-r border-slate-700/30">{t("colCode")}</th>
                            <th className="px-3 py-2.5 text-left   text-[10px] font-semibold tracking-wider uppercase min-w-[200px] border-r border-slate-700/30">{t("colDescription")}</th>
                            <th className="px-3 py-2.5 text-right  text-[10px] font-semibold tracking-wider uppercase w-14 border-r border-slate-700/30">{t("colQuantity")}</th>
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold tracking-wider uppercase w-12 border-r border-slate-700/30">{t("colUnit")}</th>
                            <th className="px-3 py-2.5 text-right  text-[10px] font-semibold tracking-wider uppercase w-20 border-r border-slate-700/30">{t("colUnitPrice")} ({currencySymbol})</th>
                            <th className="px-3 py-2.5 text-right  text-[10px] font-semibold tracking-wider uppercase w-14 border-r border-slate-700/30">{t("colDiscount")}</th>
                            <th className="px-3 py-2.5 text-right  text-[10px] font-semibold tracking-wider uppercase w-20 border-r border-slate-700/30">{t("colNet")} ({currencySymbol})</th>
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold tracking-wider uppercase w-14 border-r border-slate-700/30">{t("colVatRate")}</th>
                            <th className="px-3 py-2.5 text-right  text-[10px] font-semibold tracking-wider uppercase w-20 border-r border-slate-700/30">{t("colVatAmount")} ({currencySymbol})</th>
                            <th className="px-3 py-2.5 text-right  text-[10px] font-semibold tracking-wider uppercase w-24 border-r border-slate-700/30">{t("colTotal")} ({currencySymbol})</th>
                            <th className="px-3 py-2.5 text-center text-[10px] font-semibold tracking-wider uppercase w-32">{t("colErpMatch")}</th>
                          </tr>
                          </thead>
                          <tbody>
                          {lineItems.map((item: any, idx: number) => {
                            const borderColor =
                                item.matchStatus === "matched" || item.matchStatus === "manual"
                                    ? "border-l-emerald-400"
                                    : item.matchStatus === "failed"
                                        ? "border-l-red-400"
                                        : "border-l-amber-400";
                            return (
                                <tr key={item.id} className={`${idx % 2 === 0 ? "bg-white" : "bg-slate-50/60"} hover:bg-blue-50/50 transition-colors border-l-2 ${borderColor}`}>
                                  <td className="px-3 py-3 text-xs text-slate-400 text-center tabular-nums border-r border-slate-100">{item.lineNumber || idx + 1}</td>
                                  <td className="px-3 py-3 border-r border-slate-100">
                                <span className={`font-mono text-xs font-bold ${item.supplierCode ? "text-slate-800" : "text-slate-300"}`}>
                                  {item.supplierCode || "—"}
                                </span>
                                  </td>
                                  <td className="px-3 py-3 border-r border-slate-100">
                                    <p className="text-xs text-slate-800 leading-snug">{item.description || `Item ${idx + 1}`}</p>
                                  </td>
                                  <td className="px-3 py-3 text-xs text-right tabular-nums font-medium text-slate-700 border-r border-slate-100">{item.quantity ?? "—"}</td>
                                  <td className="px-3 py-3 text-[11px] text-center text-slate-400 border-r border-slate-100">{item.unit || "—"}</td>
                                  <td className="px-3 py-3 text-xs text-right tabular-nums font-medium text-slate-700 border-r border-slate-100">{fmt(item.unitPrice)}</td>
                                  <td className="px-3 py-3 text-xs text-right tabular-nums text-slate-400 border-r border-slate-100">
                                    {parseFloat(item.discount1 || "0") > 0 ? fmt(item.discount1) : "—"}
                                  </td>
                                  <td className="px-3 py-3 text-xs text-right tabular-nums font-semibold text-slate-800 border-r border-slate-100">{fmt(item.netAmount)}</td>
                                  <td className="px-3 py-3 text-xs text-center text-slate-500 border-r border-slate-100">{item.vatRate ? `${item.vatRate}%` : "—"}</td>
                                  <td className="px-3 py-3 text-xs text-right tabular-nums text-slate-500 border-r border-slate-100">{fmt(item.vatAmount)}</td>
                                  <td className="px-3 py-3 text-xs text-right tabular-nums font-bold text-slate-900 border-r border-slate-100">{fmt(item.totalWithVat)}</td>
                                  <td className="px-3 py-3">
                                    <div className="flex flex-col items-center gap-1.5">
                                      {item.erpCode ? (
                                          <>
                                            <span className="font-mono text-[10px] font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded border border-blue-200">{item.erpCode}</span>
                                            <StatusBadge status={item.matchStatus} confidence={item.matchConfidence} t={t} />
                                          </>
                                      ) : (
                                          <>
                                            <StatusBadge status={item.matchStatus} t={t} />
                                            <button
                                                onClick={() => { setSelectedLineItem(item); setShowMatchDialog(true); }}
                                                className="text-[10px] font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-0.5 bg-blue-50 hover:bg-blue-100 px-2 py-0.5 rounded transition"
                                            >
                                              <Sparkles className="h-2.5 w-2.5" /> Match
                                            </button>
                                          </>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                            );
                          })}
                          </tbody>
                          <tfoot>
                          <tr className="border-t-2 border-slate-300" style={{ background: "linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)" }}>
                            <td colSpan={7} className="px-3 py-3 text-right text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t("totals")}</td>
                            <td className="px-3 py-3 text-right text-xs tabular-nums font-bold text-slate-800 border-r border-slate-200">{fmt(sumNet)}</td>
                            <td className="border-r border-slate-200" />
                            <td className="px-3 py-3 text-right text-xs tabular-nums font-bold text-slate-600 border-r border-slate-200">{fmt(sumVat)}</td>
                            <td className="px-3 py-3 text-right text-xs tabular-nums font-bold text-slate-900 border-r border-slate-200">{fmt(sumTotal)}</td>
                            <td />
                          </tr>
                          </tfoot>
                        </table>
                      </div>
                  ) : (
                      <div className="text-center py-14">
                        <div className="h-12 w-12 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-3">
                          <FileText className="h-6 w-6 text-slate-300" />
                        </div>
                        <p className="text-sm font-medium text-slate-600">{t("noLineItems")}</p>
                        <p className="text-xs text-slate-400 mt-1">{t("noLineItemsHint")}</p>
                      </div>
                  )}
                </div>
              </>
          )}
        </div>

        {/* ═══════ MATCH DIALOG (i18n) ═══════ */}
        <Dialog open={showMatchDialog} onOpenChange={setShowMatchDialog}>
          <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="text-base">{t("selectProductMatch")}</DialogTitle>
              <DialogDescription className="text-xs">{t("chooseErp")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 mt-3">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                <p className="text-sm font-medium text-slate-800">{selectedLineItem?.description}</p>
                <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-slate-400">
                  <span>{t("code")}: <span className="font-mono text-slate-600 font-semibold">{selectedLineItem?.supplierCode || "N/A"}</span></span>
                  <span>{t("qty")}: <span className="text-slate-600">{selectedLineItem?.quantity || "N/A"}</span></span>
                  <span>{t("price")}: <span className="text-slate-600">{money(selectedLineItem?.unitPrice, currencySymbol)}</span></span>
                  <span>{t("net")}: <span className="font-semibold text-slate-700">{money(selectedLineItem?.netAmount, currencySymbol)}</span></span>
                </div>
              </div>

              <div>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                  <Sparkles className="h-3 w-3 text-amber-500" />
                  {t("mlSuggestedMatches")}
                </p>
                {matchQuery.isLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <Loader2 className="h-5 w-5 animate-spin text-slate-300" />
                      <span className="ml-2 text-xs text-slate-400">{t("runningMl")}</span>
                    </div>
                ) : matchQuery.isError ? (
                    <div className="p-3 rounded-xl border border-amber-200 bg-amber-50 text-xs text-amber-700 flex items-center gap-2">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {t("mlUnavailable")}
                    </div>
                ) : mlMatches.length > 0 ? (
                    <div className="space-y-1.5">
                      {mlMatches.map((match: any, idx: number) => (
                          <div key={idx}
                               className="p-3 rounded-xl border border-slate-200 hover:border-blue-300 hover:bg-blue-50/50 cursor-pointer transition-all"
                               onClick={() => handleSelectMatch(selectedLineItem, match)}>
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="font-mono text-sm font-bold text-slate-800">{match.erpCode}</p>
                                <p className="text-xs text-slate-400 mt-0.5">{match.description || getMethodLabel(match.method)}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-400 capitalize">{match.method}</span>
                                {getConfBadge(Math.round(match.confidence))}
                              </div>
                            </div>
                          </div>
                      ))}
                    </div>
                ) : (
                    <div className="p-4 rounded-xl border border-dashed border-slate-200 text-center text-xs text-slate-400">
                      {t("noMlMatches")}
                    </div>
                )}
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-100" /></div>
                <div className="relative flex justify-center text-[9px] uppercase tracking-widest">
                  <span className="bg-white px-2 text-slate-300">{t("orSearch")}</span>
                </div>
              </div>

              <div>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5 mb-2">
                  <Search className="h-3 w-3" />
                  {t("searchProducts")}
                </p>
                <div className="flex gap-2">
                  <Input placeholder={t("searchPlaceholder")} value={searchQuery} className="text-xs h-9"
                         onChange={e => { setSearchQuery(e.target.value); setIsSearching(false); }}
                         onKeyDown={e => { if (e.key === "Enter" && searchQuery.length >= 2) setIsSearching(true); }} />
                  <Button variant="outline" size="sm" className="h-9 px-3"
                          onClick={() => { if (searchQuery.length >= 2) setIsSearching(true); }}
                          disabled={searchQuery.length < 2}>
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {isSearching && searchResults.isLoading && (
                    <div className="flex items-center py-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-300" />
                      <span className="ml-2 text-xs text-slate-400">{t("searching")}</span>
                    </div>
                )}
                {isSearching && searchResults.data && (
                    <div className="space-y-1 mt-2 max-h-32 overflow-y-auto">
                      {(searchResults.data as any[]).length > 0 ? (
                          (searchResults.data as any[]).map((p: any, i: number) => (
                              <div key={i}
                                   className="p-2 rounded-lg border border-slate-100 hover:border-blue-300 hover:bg-blue-50/50 cursor-pointer text-xs transition-all"
                                   onClick={() => handleSelectMatch(selectedLineItem, { erpCode: p.erpCode, confidence: 100, method: "manual" })}>
                                <span className="font-mono font-bold">{p.erpCode}</span>
                                {p.description && <span className="text-slate-400 ml-2">- {p.description}</span>}
                              </div>
                          ))
                      ) : (
                          <p className="text-xs text-slate-400 py-2">{t("noResultsFor")} "{searchQuery}"</p>
                      )}
                    </div>
                )}
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-slate-100" /></div>
                <div className="relative flex justify-center text-[9px] uppercase tracking-widest">
                  <span className="bg-white px-2 text-slate-300">{t("orEnterManually")}</span>
                </div>
              </div>

              {!showManualInput ? (
                  <Button variant="outline" className="w-full text-xs h-9 border-slate-200" onClick={() => setShowManualInput(true)}>
                    <Keyboard className="mr-1.5 h-3.5 w-3.5" />
                    {t("enterErpManually")}
                  </Button>
              ) : (
                  <div className="p-3 rounded-xl border border-slate-200 space-y-2">
                    <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                      <Keyboard className="h-3 w-3" />
                      {t("manualEntry")}
                    </p>
                    <div className="flex gap-2">
                      <Input placeholder={t("erpCodePlaceholder")} value={manualErpCode} className="text-xs h-9 font-mono" autoFocus
                             onChange={e => setManualErpCode(e.target.value)}
                             onKeyDown={e => { if (e.key === "Enter") handleManualConfirm(selectedLineItem); }} />
                      <Button size="sm" className="h-9 bg-primary hover:bg-primary/90 text-white text-xs"
                              onClick={() => handleManualConfirm(selectedLineItem)}
                              disabled={!manualErpCode.trim() || confirmMatchMutation.isPending}>
                        {confirmMatchMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : (
                            <><CheckCircle2 className="mr-1 h-3.5 w-3.5" />{t("confirm")}</>
                        )}
                      </Button>
                    </div>
                  </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* ═══════ DELETE CONFIRMATION (i18n) ═══════ */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center">
                  <Trash2 className="h-4 w-4 text-red-600" />
                </div>
                {t("deleteTitle")}
              </DialogTitle>
              <DialogDescription className="text-xs pt-2">
                {t("deleteWarning1")}{" "}
                <span className="font-semibold">#{extractedData.invoiceNumber || invoice.invoiceNumber || id}</span>{" "}
                {t("deleteWarning2")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2 justify-end mt-4">
              <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setShowDeleteConfirm(false)}>
                {t("cancel")}
              </Button>
              <Button size="sm" className="text-xs h-8 bg-red-600 hover:bg-red-500 text-white"
                      onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Trash2 className="h-3.5 w-3.5 mr-1" />}
                {t("deleteTitle")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* ═══════ EXTRACTION DEBUG PANEL (UNTOUCHED — developer tool) ═══════ */}
        {extractedData && (
            <div className="fixed bottom-4 right-4 z-50 w-[520px] max-h-[78vh] flex flex-col shadow-2xl rounded-xl border border-slate-200 bg-white overflow-hidden">
              <button
                  className="flex items-center justify-between px-4 py-2.5 bg-slate-900 text-white text-xs font-mono cursor-pointer select-none hover:bg-slate-800 transition-colors"
                  onClick={() => setShowDebug(v => !v)}
              >
              <span className="flex items-center gap-2">
                <Terminal className="h-3.5 w-3.5 text-green-400" />
                <span className="font-semibold">Extraction Debug</span>

                {extractedData._vlm_extraction_method && (() => {
                  const m = extractedData._vlm_extraction_method;
                  const cfg: Record<string,[string,string]> = {
                    native_text: ["📄 TEXT", "bg-emerald-900 text-emerald-300"],
                    ocr_image:   ["🔍 OCR",  "bg-amber-900 text-amber-300"],
                    vlm:         ["🤖 VLM",  "bg-violet-900 text-violet-300"],
                    converted:   ["📋 CONV", "bg-blue-900 text-blue-300"],
                  };
                  const [label, cls] = cfg[m] ?? ["⚙ " + m.toUpperCase(), "bg-slate-700 text-slate-300"];
                  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${cls}`}>{label}</span>;
                })()}

                {extractedData._extractionStrategy && extractedData._extractionStrategy !== "unknown" && (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        extractedData._extractionStrategy === "table"
                            ? "bg-blue-900 text-blue-300"
                            : "bg-amber-900 text-amber-300"
                    }`}>
                    {extractedData._extractionStrategy?.toUpperCase()}
                  </span>
                )}

                {extractedData.vlm_escalated && (
                    <span className="bg-orange-900 text-orange-300 px-1.5 py-0.5 rounded text-[10px]">
                    VLM↑
                  </span>
                )}

                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                    (data?.lineItems?.length ?? 0) > 0
                        ? "bg-emerald-900 text-emerald-300"
                        : "bg-red-900 text-red-400"
                }`}>
                  {data?.lineItems?.length ?? 0} items
                </span>
              </span>
                {showDebug
                    ? <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
                    : <ChevronUp   className="h-3.5 w-3.5 text-slate-400" />}
              </button>

              {showDebug && (
                  <div className="overflow-y-auto flex-1 divide-y divide-slate-100 text-xs">
                    <div className="p-3 bg-slate-50">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">Pipeline</p>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          ["Method",      extractedData._vlm_extraction_method === "native_text" ? "📄 pdfplumber (text PDF)" : extractedData._vlm_extraction_method === "ocr_image" ? "🔍 Surya OCR (scanned)" : extractedData._vlm_extraction_method ?? "—"],
                          ["Strategy",    extractedData._extractionStrategy ?? "—"],
                          ["Raw text",    extractedData._rawTextLen != null ? `${extractedData._rawTextLen} ch` : "—"],
                          ["Tables",      extractedData._tablesFound != null ? String(extractedData._tablesFound) : "—"],
                          ["Before dedup",extractedData._itemsBeforeDedup != null ? String(extractedData._itemsBeforeDedup) : "—"],
                          ["After dedup", String(data?.lineItems?.length ?? "—")],
                          ["Confidence",  extractedData.confidence != null ? `${extractedData.confidence}%` : extractedData.classificationConfidence != null ? `${extractedData.classificationConfidence}%` : "—"],
                          ["VLM engine",  extractedData._vlm_engine ?? "—"],
                          ["Escalated",   extractedData.vlm_escalated ? "YES ⚠" : "no"],
                          ["Doc type",    extractedData.documentType ?? "—"],
                        ].map(([label, val]) => (
                            <div key={String(label)}>
                              <p className="text-[9px] text-slate-400 uppercase">{label}</p>
                              <p className={`font-mono font-semibold text-[11px] ${
                                  label === "Escalated" && val !== "no" ? "text-orange-600" :
                                      label === "Strategy" && val === "text" ? "text-amber-600" :
                                          label === "Strategy" && val === "table" ? "text-blue-600" :
                                              "text-slate-800"
                              }`}>{val}</p>
                            </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-3">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">Header fields</p>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
                        {[
                          ["Invoice #",  extractedData.invoiceNumber],
                          ["Date",       extractedData.invoiceDate],
                          ["Issuer",     extractedData.issuer?.name || extractedData.supplierName],
                          ["Iss. VAT",   extractedData.issuer?.vatNumber || extractedData.supplierVatNumber],
                          ["Iss. IBAN",  extractedData.issuer?.iban],
                          ["Recipient",  extractedData.recipient?.name || extractedData.customerName],
                          ["Rec. VAT",   extractedData.recipient?.vatNumber || extractedData.customerVatNumber],
                          ["Rec. City",  extractedData.recipient?.city],
                          ["Subtotal",   extractedData.subtotal != null ? `€${extractedData.subtotal}` : null],
                          ["VAT",        extractedData.vatAmount != null ? `€${extractedData.vatAmount}` : null],
                          ["Total",      extractedData.totalAmount != null ? `€${extractedData.totalAmount}` : null],
                          ["Payable",    extractedData.payableAmount != null ? `€${extractedData.payableAmount}` : null],
                          ["ΜΑΡΚ",       extractedData.mark],
                          ["Currency",   extractedData.currency],
                        ].filter(([, v]) => v != null && v !== "").map(([label, val]) => (
                            <div key={String(label)} className="flex gap-1.5">
                              <span className="text-slate-400 shrink-0">{label}:</span>
                              <span className="text-slate-800 truncate font-medium">{String(val)}</span>
                            </div>
                        ))}
                      </div>
                    </div>

                    <div className="p-3">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">
                        Line items ({data?.lineItems?.length ?? 0} in DB
                        {extractedData._itemsBeforeDedup != null && extractedData._itemsBeforeDedup !== data?.lineItems?.length
                            ? `, ${extractedData._itemsBeforeDedup} before dedup`
                            : ""})
                      </p>
                      {data?.lineItems?.length ? (
                          <div className="overflow-x-auto">
                            <table className="w-full text-[10px] font-mono">
                              <thead>
                              <tr className="text-slate-400 border-b border-slate-100">
                                <th className="text-left py-0.5 pr-2">#</th>
                                <th className="text-left py-0.5 pr-2">Code</th>
                                <th className="text-left py-0.5 pr-2">Description</th>
                                <th className="text-right py-0.5 pr-2">Qty</th>
                                <th className="text-right py-0.5 pr-2">Price</th>
                                <th className="text-right py-0.5 pr-2">Net</th>
                                <th className="text-center py-0.5 pr-2">Unit</th>
                                <th className="text-center py-0.5">Match</th>
                              </tr>
                              </thead>
                              <tbody>
                              {data.lineItems.map((li: any, i: number) => (
                                  <tr key={li.id} className={`border-t border-slate-50 ${
                                      li.matchStatus === "matched" || li.matchStatus === "manual"
                                          ? "text-emerald-700"
                                          : li.matchStatus === "failed"
                                              ? "text-red-500"
                                              : "text-slate-700"
                                  }`}>
                                    <td className="py-0.5 pr-2 text-slate-400">{i + 1}</td>
                                    <td className="py-0.5 pr-2 max-w-[56px] truncate font-bold">{li.supplierCode || "—"}</td>
                                    <td className="py-0.5 pr-2 max-w-[130px] truncate">{li.description}</td>
                                    <td className="py-0.5 pr-2 text-right">{li.quantity}</td>
                                    <td className="py-0.5 pr-2 text-right">{li.unitPrice}</td>
                                    <td className="py-0.5 pr-2 text-right font-semibold">{li.netAmount}</td>
                                    <td className="py-0.5 pr-2 text-center text-slate-400">{li.unit || "—"}</td>
                                    <td className="py-0.5 text-center">
                                    <span className={`px-1 rounded text-[9px] ${
                                        li.matchStatus === "matched" || li.matchStatus === "manual"
                                            ? "bg-emerald-100 text-emerald-700"
                                            : li.matchStatus === "failed"
                                                ? "bg-red-100 text-red-600"
                                                : "bg-amber-100 text-amber-600"
                                    }`}>
                                      {li.erpCode || li.matchStatus}
                                    </span>
                                    </td>
                                  </tr>
                              ))}
                              </tbody>
                            </table>
                          </div>
                      ) : (
                          <p className="text-slate-400 italic text-[10px]">No line items in DB yet</p>
                      )}
                    </div>

                    {(extractedData._vlm_raw_text || extractedData.rawTextPreview) && (
                        <div className="p-3">
                          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mb-2">
                            Raw OCR text
                            {extractedData._vlm_raw_text
                                ? ` (${extractedData._vlm_raw_text.length} chars)`
                                : " (preview)"}
                          </p>
                          <pre className="text-[10px] text-slate-600 whitespace-pre-wrap font-mono bg-slate-50 rounded p-2 max-h-48 overflow-y-auto leading-relaxed">
                        {extractedData._vlm_raw_text
                            ? extractedData._vlm_raw_text.slice(0, 2000) + (extractedData._vlm_raw_text.length > 2000 ? "\n…" : "")
                            : extractedData.rawTextPreview}
                      </pre>
                        </div>
                    )}
                  </div>
              )}
            </div>
        )}
      </DashboardLayout>
  );
}
