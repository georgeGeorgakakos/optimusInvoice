/**
 * Business Portal (ΓΕΜΗ) Open Data API client.
 *
 * Provides Greek company lookup by ΑΦΜ (VAT) or Αρ. ΓΕΜΗ (registration number).
 * Used to auto-populate client_profile.json from the ΓΕΜΗ public registry,
 * so onboarding a new tenant takes ~60 seconds instead of manual data entry.
 *
 * Registration: https://opendata.businessportal.gr/register/
 * Swagger:      https://opendata-api.businessportal.gr/opendata/docs/
 *
 * Requires env var BUSINESS_PORTAL_API_KEY (set in .env).
 *
 * NOTE on endpoints: the exact URL paths and auth header convention used here
 * are based on the documented REST pattern. Once you have the real API key
 * and can hit the swagger, verify the endpoint paths below against the OpenAPI
 * spec and adjust if needed. The shape of the response normalisation (Greek-
 * transliterated field names) is the part most likely to need tuning per the
 * actual upstream format — that lives in normaliseCompany() and is defensive.
 */

interface BusinessPortalCompany {
    arithmosGemi?: string;                // ΓΕΜΗ number
    vat?: string;                         // ΑΦΜ
    legalName?: string;                   // Επωνυμία
    commerceTitle?: string;               // Διακριτικός τίτλος
    legalForm?: string;                   // Νομική μορφή (e.g. "ΑΝΩΝΥΜΗ ΕΤΑΙΡΕΙΑ")
    status?: string;                      // Κατάσταση (ENERGI/SE_LIKIDASI/DIAGRAFI)
    registeredSeatRegion?: string;        // Έδρα: περιοχή / περιφέρεια
    registeredSeatMunicipality?: string;  // Έδρα: δήμος
    incorporationDate?: string;           // Ημ/νία σύστασης
    shareCapital?: number;                // Κεφάλαιο
    currency?: string;                    // Νόμισμα κεφαλαίου
    raw?: Record<string, unknown>;        // Full upstream response, kept for debugging
}

const BASE_URL =
    process.env.BUSINESS_PORTAL_API_URL ||
    "https://opendata-api.businessportal.gr/opendata";

function getApiKey(): string {
    const key = process.env.BUSINESS_PORTAL_API_KEY;
    if (!key) {
        throw new Error(
            "BUSINESS_PORTAL_API_KEY is not set. Register at " +
            "https://opendata.businessportal.gr/register/ and add the key to .env"
        );
    }
    return key;
}

/**
 * Look up a Greek company by VAT number.
 * Returns null if the VAT is not found in ΓΕΜΗ (e.g. natural person, foreign entity).
 * Throws on network errors, auth failures, or quota exhaustion.
 */
export async function searchCompanyByVat(
    vat: string
): Promise<BusinessPortalCompany | null> {
    if (!vat) return null;

    // Normalise: strip "EL" prefix and any whitespace
    const cleaned = vat.replace(/^EL/i, "").replace(/\s+/g, "");
    if (!/^\d{9}$/.test(cleaned)) {
        throw new Error(`Invalid Greek VAT format: ${vat} (expected 9 digits)`);
    }

    const url = `${BASE_URL}/companies/search?vatNumber=${cleaned}`;
    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${getApiKey()}`,
        },
    });

    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
            `Business Portal API error: ${res.status} ${res.statusText} — ${text.substring(0, 300)}`
        );
    }

    const data = await res.json();
    // Some endpoints return an array of results, some a single object — handle both
    const first = Array.isArray(data) ? data[0] : data;
    return first ? normaliseCompany(first) : null;
}

/**
 * Look up a company by Αρ. ΓΕΜΗ (registration number).
 * Useful when the VAT lookup returns multiple entities and the user picks one.
 */
export async function showCompanyByGemi(
    gemi: string
): Promise<BusinessPortalCompany | null> {
    if (!gemi) return null;
    const cleaned = gemi.replace(/\s+/g, "");
    const url = `${BASE_URL}/companies/${encodeURIComponent(cleaned)}`;
    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${getApiKey()}`,
        },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
            `Business Portal API error: ${res.status} ${res.statusText} — ${text.substring(0, 300)}`
        );
    }
    const data = await res.json();
    return normaliseCompany(data);
}

/**
 * Normalise the upstream response into a stable shape regardless of which
 * field naming convention the API uses for any given endpoint (Greek-
 * transliterated like "eponymia" vs English camelCase like "legalName"). We
 * try every variant we've observed in the wild, falling back gracefully.
 */
function normaliseCompany(raw: any): BusinessPortalCompany {
    const get = (...keys: string[]): string | undefined => {
        for (const k of keys) {
            if (raw?.[k] != null && String(raw[k]).trim()) {
                return String(raw[k]).trim();
            }
        }
        return undefined;
    };

    const capitalRaw = get("kefaleo", "shareCapital", "share_capital");
    const capitalNum = capitalRaw
        ? parseFloat(capitalRaw.replace(/[^\d.]/g, ""))
        : undefined;

    return {
        arithmosGemi:               get("arithmos_gemi", "arithmosGemi", "gemiNumber"),
        vat:                        get("afm", "vat", "vatNumber"),
        legalName:                  get("eponymia", "legalName", "legal_name"),
        commerceTitle:              get("diakritikos_titlos", "commerceTitle", "commerce_title"),
        legalForm:                  get("nomiki_morfi", "legalForm", "legal_form"),
        status:                     get("katastasi", "status"),
        registeredSeatRegion:       get("edra_periohi", "registeredSeatRegion", "region"),
        registeredSeatMunicipality: get("edra_dimos", "registeredSeatMunicipality", "municipality"),
        incorporationDate:          get("imrominia_systasis", "incorporationDate"),
        shareCapital:               capitalNum && !isNaN(capitalNum) ? capitalNum : undefined,
        currency:                   get("nomisma_kefalaiou", "currency"),
        raw,
    };
}

/**
 * Convert a BusinessPortalCompany result into a draft client_profile.json
 * matching the schema expected by client_profile.py. The user can review
 * and add their own patterns (address regex etc.) before saving.
 *
 * - clientNamePatterns gets BOTH the legal name and the commerce title
 *   (because invoices may use either).
 * - skipIssuerPatterns gets the same patterns by default (the client name
 *   appearing on an invoice means it's the recipient, not the issuer).
 * - clientAddressPatterns gets municipality + region as crude defaults; the
 *   user should refine these with street-level patterns if they have them.
 */
export function companyToProfileDraft(
    company: BusinessPortalCompany,
    vat: string
): Record<string, unknown> {
    const cleanedVat = vat.replace(/^EL/i, "").replace(/\s+/g, "");
    const name = company.legalName || company.commerceTitle || "Unknown";

    const namePatterns: string[] = [];
    if (company.legalName) namePatterns.push(escapeRegex(company.legalName));
    if (
        company.commerceTitle &&
        company.commerceTitle !== company.legalName
    ) {
        namePatterns.push(escapeRegex(company.commerceTitle));
    }

    return {
        clientName: name,
        // Include both formats — invoices vary: "EL094325446" or just "094325446"
        clientVats: [`EL${cleanedVat}`, cleanedVat],
        clientNamePatterns: namePatterns,
        clientAddressPatterns: [
            ...(company.registeredSeatMunicipality
                ? [escapeRegex(company.registeredSeatMunicipality)]
                : []),
            ...(company.registeredSeatRegion
                ? [escapeRegex(company.registeredSeatRegion)]
                : []),
        ],
        // If the client name appears as a line in the document, that line is the
        // recipient — must NOT be picked as the issuer.
        skipIssuerPatterns: namePatterns,
        managerPatterns: [],
        metadata: {
            gemi:               company.arithmosGemi,
            legalForm:          company.legalForm,
            status:             company.status,
            municipality:       company.registeredSeatMunicipality,
            region:             company.registeredSeatRegion,
            incorporationDate:  company.incorporationDate,
            shareCapital:       company.shareCapital,
            currency:           company.currency,
            // Audit trail: when this draft was generated
            autoFilledAt:       new Date().toISOString(),
            autoFilledFrom:     "ΓΕΜΗ Open Data",
        },
    };
}

/**
 * Escape regex metacharacters but preserve Greek and Latin letters
 * (so that "ΜΕΤΡΟ ΑΕΒΕ" remains a usable regex pattern that just matches
 * itself literally).
 */
function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}