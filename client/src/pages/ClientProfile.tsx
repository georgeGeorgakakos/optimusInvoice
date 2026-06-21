/**
 * ClientProfile.tsx
 *
 * UI for managing the active client profile — i.e., WHO this deployment is
 * extracting invoices FOR (METRO, Ferryscanner, etc.). Three flows:
 *
 *   1. AUTO-FILL: type ΑΦΜ → click button → ΓΕΜΗ API populates the form
 *   2. MANUAL:    type/edit any field directly
 *   3. REVIEW:    view metadata badges (ΓΕΜΗ number, legal form, status, …)
 *
 * The saved profile is written atomically to disk by the backend
 * (server/clientProfileRouter.ts → upsert). The Python pipeline picks up the
 * change via mtime watch — no container restart needed. A successful save is
 * live on the very next invoice extraction.
 *
 * Companion files:
 *   - server/clientProfileRouter.ts   (tRPC: get / upsert / lookupByVat)
 *   - server/businessPortalClient.ts  (ΓΕΜΗ Open Data API client)
 *   - server/python/client_profile.py (Python loader with mtime auto-reload)
 *
 * IMPORT PATHS to verify for your project:
 *   - The `trpc` client import path below (default: "@/lib/trpc")
 *   - The `toast` library (default: "sonner") — adjust if you use the older
 *     shadcn `useToast()` hook from "@/components/ui/use-toast" instead.
 *
 * LAYOUT WRAPPING:
 *   - The entire returned JSX is wrapped in <DashboardLayout> so that the
 *     sidebar/header chrome is rendered around the page. This matches the
 *     per-page layout pattern used elsewhere in the app (see e.g.
 *     KnowledgeBase.tsx, Configuration.tsx). Without this wrap the page
 *     would render bare with no sidebar or navigation.
 */

import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc"; // ⚠️ adjust path to your tRPC client
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
    Card,
    CardHeader,
    CardTitle,
    CardDescription,
    CardContent,
    CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
    Loader2,
    Search,
    Save,
    Building2,
    AlertCircle,
    CheckCircle2,
    Sparkles,
    Info,
} from "lucide-react";
import { toast } from "sonner"; // ⚠️ swap with your toast lib if different
import DashboardLayout from "@/components/DashboardLayout";


// ── iKnowHow brand colours (kept inline so we don't have to import a theme) ──
const BRAND_NAVY  = "#0f1629";
const BRAND_CORAL = "#E8472A";

// ───────────────────────────────────────────────────────────────────────────
// Types — mirror the schema written by client_profile.py + lookupByVat draft
// ───────────────────────────────────────────────────────────────────────────

interface ProfileMetadata {
    gemi?: string;
    legalForm?: string;
    status?: string;
    municipality?: string;
    region?: string;
    incorporationDate?: string;
    shareCapital?: number;
    currency?: string;
    autoFilledAt?: string;
    autoFilledFrom?: string;
}

interface ClientProfileData {
    clientName?: string;
    clientVats?: string[];
    clientNamePatterns?: string[];
    clientAddressPatterns?: string[];
    skipIssuerPatterns?: string[];
    managerPatterns?: string[];
    metadata?: ProfileMetadata;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers: convert between arrays (storage) and strings (textarea/input)
// ───────────────────────────────────────────────────────────────────────────

const arrayToLines = (arr?: string[]): string => (arr || []).join("\n");
const linesToArray = (text: string): string[] =>
    text.split("\n").map(s => s.trim()).filter(Boolean);

const arrayToCsv = (arr?: string[]): string => (arr || []).join(", ");
const csvToArray = (text: string): string[] =>
    text.split(",").map(s => s.trim()).filter(Boolean);

// ───────────────────────────────────────────────────────────────────────────
// Main page
// ───────────────────────────────────────────────────────────────────────────

export default function ClientProfilePage() {
    // Auto-fill input — separate from the saved VATs so the user can look up
    // one VAT and then edit/append before saving.
    const [vatInput, setVatInput] = useState("");

    // Form state. Each pattern list is held as a string (textarea contents) and
    // converted to/from arrays at the edges (on load, on save, on auto-fill).
    const [clientName, setClientName]                   = useState("");
    const [clientVatsText, setClientVatsText]           = useState("");
    const [namePatternsText, setNamePatternsText]       = useState("");
    const [addressPatternsText, setAddressPatternsText] = useState("");
    const [skipPatternsText, setSkipPatternsText]       = useState("");
    const [managerPatternsText, setManagerPatternsText] = useState("");
    const [metadata, setMetadata]                       = useState<ProfileMetadata | undefined>();

    // ── Load existing profile on mount ─────────────────────────────────────
    const profileQuery = trpc.clientProfile.get.useQuery();

    useEffect(() => {
        if (profileQuery.data?.profile) {
            const p = profileQuery.data.profile as ClientProfileData;
            setClientName(p.clientName || "");
            setClientVatsText(arrayToCsv(p.clientVats));
            setNamePatternsText(arrayToLines(p.clientNamePatterns));
            setAddressPatternsText(arrayToLines(p.clientAddressPatterns));
            setSkipPatternsText(arrayToLines(p.skipIssuerPatterns));
            setManagerPatternsText(arrayToLines(p.managerPatterns));
            setMetadata(p.metadata);
            // Pre-fill the auto-fill input with the first VAT so the user sees
            // what's currently loaded.
            if (p.clientVats && p.clientVats.length > 0) {
                setVatInput(p.clientVats[0].replace(/^EL/i, ""));
            }
        }
    }, [profileQuery.data]);

    // ── Auto-fill via ΓΕΜΗ Open Data API ───────────────────────────────────
    const lookupMutation = trpc.clientProfile.lookupByVat.useMutation({
        onSuccess: data => {
            if (!data.found || !data.draft) {
                toast.warning(data.message || "Δεν βρέθηκε επιχείρηση στο ΓΕΜΗ");
                return;
            }
            // Populate form with the draft — user can then review & edit.
            const draft = data.draft as ClientProfileData;
            setClientName(draft.clientName || "");
            setClientVatsText(arrayToCsv(draft.clientVats));
            setNamePatternsText(arrayToLines(draft.clientNamePatterns));
            setAddressPatternsText(arrayToLines(draft.clientAddressPatterns));
            setSkipPatternsText(arrayToLines(draft.skipIssuerPatterns));
            setManagerPatternsText(arrayToLines(draft.managerPatterns));
            setMetadata(draft.metadata);
            toast.success(`Συμπληρώθηκε από ΓΕΜΗ: ${draft.clientName || "(unnamed)"}`);
        },
        onError: err => {
            toast.error(`Σφάλμα αναζήτησης: ${err.message}`);
        },
    });

    const handleAutoFill = () => {
        const cleaned = vatInput.replace(/^EL/i, "").replace(/\s+/g, "");
        if (!/^\d{9}$/.test(cleaned)) {
            toast.error("Μη έγκυρο ΑΦΜ — πρέπει να είναι 9 ψηφία");
            return;
        }
        lookupMutation.mutate({ vat: cleaned });
    };

    // ── Save profile ───────────────────────────────────────────────────────
    const upsertMutation = trpc.clientProfile.upsert.useMutation({
        onSuccess: () => {
            toast.success("Profile αποθηκεύτηκε. Ενεργό από το επόμενο extraction.");
            profileQuery.refetch();
        },
        onError: err => {
            toast.error(`Σφάλμα αποθήκευσης: ${err.message}`);
        },
    });

    const handleSave = () => {
        const profile: ClientProfileData = {
            clientName:            clientName.trim() || undefined,
            clientVats:            csvToArray(clientVatsText),
            clientNamePatterns:    linesToArray(namePatternsText),
            clientAddressPatterns: linesToArray(addressPatternsText),
            skipIssuerPatterns:    linesToArray(skipPatternsText),
            managerPatterns:       linesToArray(managerPatternsText),
            metadata,
        };
        upsertMutation.mutate({ profile });
    };

    // ── Render ─────────────────────────────────────────────────────────────
    const isLoading  = profileQuery.isLoading;
    const hasProfile = profileQuery.data?.profile != null;
    const hasAnyMeta = metadata && Object.values(metadata).some(v => v != null && v !== "");

    // The DashboardLayout wrapper provides the sidebar + header chrome that's
    // standard across all authenticated pages. Without it, the page renders
    // bare (no menu, no header) — that was the bug fixed in this iteration.
    return (
        <DashboardLayout>
            <div className="container max-w-4xl mx-auto py-8 space-y-6">
                {/* ── Header ──────────────────────────────────────────────────────── */}
                <div className="space-y-1">
                    <h1 className="text-3xl font-bold tracking-tight" style={{ color: BRAND_NAVY }}>
                        Client Profile
                    </h1>
                    <p className="text-muted-foreground">
                        Η ταυτότητα του παραλήπτη για αυτό το deployment. Καθορίζει πώς ο
                        parser αναγνωρίζει ποιος είναι ο "πελάτης" στα εισερχόμενα τιμολόγια
                        (vs ποιος είναι ο εκδότης).
                    </p>
                </div>

                {/* ── Auto-fill card ──────────────────────────────────────────────── */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Sparkles className="h-5 w-5" style={{ color: BRAND_CORAL }} />
                            Auto-fill από ΑΦΜ
                        </CardTitle>
                        <CardDescription>
                            Πληκτρολόγησε το ΑΦΜ και πάτα Auto-fill για να συμπληρωθούν τα
                            πεδία αυτόματα από το{" "}
                            <a
                                href="https://opendata.businessportal.gr/"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-primary"
                            >
                                ΓΕΜΗ Open Data
                            </a>
                            .
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex gap-2">
                            <Input
                                placeholder="π.χ. 094325446"
                                value={vatInput}
                                onChange={e => setVatInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === "Enter" && !lookupMutation.isPending) handleAutoFill();
                                }}
                                className="font-mono"
                                disabled={lookupMutation.isPending}
                            />
                            <Button
                                onClick={handleAutoFill}
                                disabled={lookupMutation.isPending || !vatInput.trim()}
                                style={{ backgroundColor: BRAND_CORAL, color: "white" }}
                                className="hover:opacity-90 transition-opacity"
                            >
                                {lookupMutation.isPending ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Searching ΓΕΜΗ…
                                    </>
                                ) : (
                                    <>
                                        <Search className="mr-2 h-4 w-4" />
                                        Auto-fill
                                    </>
                                )}
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* ── Profile form ────────────────────────────────────────────────── */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Building2 className="h-5 w-5" />
                            Profile fields
                        </CardTitle>
                        <CardDescription>
                            Επεξεργάσιμα. Auto-fill γεμίζει τα βασικά, εσύ προσθέτεις τα δικά
                            σου regex patterns και σώζεις.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-6">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                            </div>
                        ) : (
                            <>
                                {/* Client name */}
                                <div className="space-y-2">
                                    <Label htmlFor="clientName">
                                        Επωνυμία{" "}
                                        <span className="text-muted-foreground font-normal">(legal name)</span>
                                    </Label>
                                    <Input
                                        id="clientName"
                                        placeholder="π.χ. METRO ΑΕΒΕ"
                                        value={clientName}
                                        onChange={e => setClientName(e.target.value)}
                                    />
                                </div>

                                {/* VATs */}
                                <div className="space-y-2">
                                    <Label htmlFor="clientVats">
                                        ΑΦΜ(s){" "}
                                        <span className="text-muted-foreground font-normal">
                        (comma-separated — βάλε και EL094325446 και 094325446 για να πιάνει και τα δύο formats)
                      </span>
                                    </Label>
                                    <Input
                                        id="clientVats"
                                        placeholder="EL094325446, 094325446"
                                        value={clientVatsText}
                                        onChange={e => setClientVatsText(e.target.value)}
                                        className="font-mono"
                                    />
                                </div>

                                {/* Name patterns */}
                                <div className="space-y-2">
                                    <Label htmlFor="namePatterns">
                                        Name patterns{" "}
                                        <span className="text-muted-foreground font-normal">
                        (regex, μία ανά γραμμή — αναγνωρίζουν "αυτόν τον πελάτη" στα invoices)
                      </span>
                                    </Label>
                                    <Textarea
                                        id="namePatterns"
                                        placeholder={"METRO\\s*ΑΕΒΕ\nΜΕΤΡΟ\\s*ΑΕΒΕ\nMETRO\\s*Cash\\s*&\\s*Carry"}
                                        value={namePatternsText}
                                        onChange={e => setNamePatternsText(e.target.value)}
                                        className="font-mono text-sm"
                                        rows={4}
                                    />
                                </div>

                                {/* Address patterns */}
                                <div className="space-y-2">
                                    <Label htmlFor="addressPatterns">
                                        Address patterns{" "}
                                        <span className="text-muted-foreground font-normal">
                        (regex, μία ανά γραμμή — substrings της διεύθυνσης έδρας)
                      </span>
                                    </Label>
                                    <Textarea
                                        id="addressPatterns"
                                        placeholder={"Σώρου\\s+\\d+\nΜαρούσι"}
                                        value={addressPatternsText}
                                        onChange={e => setAddressPatternsText(e.target.value)}
                                        className="font-mono text-sm"
                                        rows={3}
                                    />
                                </div>

                                {/* Skip-issuer patterns */}
                                <div className="space-y-2">
                                    <Label htmlFor="skipPatterns">
                                        Skip-issuer patterns{" "}
                                        <span className="text-muted-foreground font-normal">
                        (γραμμές που matching εδώ είναι ΠΑΡΑΛΗΠΤΗΣ, ποτέ εκδότης)
                      </span>
                                    </Label>
                                    <Textarea
                                        id="skipPatterns"
                                        placeholder={"METRO\nΜΕΤΡΟ"}
                                        value={skipPatternsText}
                                        onChange={e => setSkipPatternsText(e.target.value)}
                                        className="font-mono text-sm"
                                        rows={3}
                                    />
                                </div>

                                {/* Manager patterns */}
                                <div className="space-y-2">
                                    <Label htmlFor="managerPatterns">
                                        Manager patterns{" "}
                                        <span className="text-muted-foreground font-normal">
                        (προαιρετικό — ονόματα που να αναγνωρίζονται ως υπεύθυνος του παραλήπτη)
                      </span>
                                    </Label>
                                    <Textarea
                                        id="managerPatterns"
                                        placeholder={"ΓΕΩΡΓΙΟΣ ΠΑΠΑΔΟΠΟΥΛΟΣ"}
                                        value={managerPatternsText}
                                        onChange={e => setManagerPatternsText(e.target.value)}
                                        className="font-mono text-sm"
                                        rows={2}
                                    />
                                </div>
                            </>
                        )}
                    </CardContent>
                    <CardFooter className="flex justify-between items-center border-t pt-4">
                        <div className="text-sm text-muted-foreground">
                            {hasProfile ? (
                                <span className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    Loaded from{" "}
                                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                      {profileQuery.data?.path?.split(/[\/\\]/).pop()}
                    </code>
                  </span>
                            ) : (
                                <span className="flex items-center gap-1.5">
                    <AlertCircle className="h-4 w-4 text-yellow-600" />
                    No profile saved yet — fill in and save
                  </span>
                            )}
                        </div>
                        <Button
                            onClick={handleSave}
                            disabled={upsertMutation.isPending || isLoading}
                            style={{ backgroundColor: BRAND_NAVY, color: "white" }}
                            className="hover:opacity-90 transition-opacity"
                        >
                            {upsertMutation.isPending ? (
                                <>
                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                    Saving…
                                </>
                            ) : (
                                <>
                                    <Save className="mr-2 h-4 w-4" />
                                    Save profile
                                </>
                            )}
                        </Button>
                    </CardFooter>
                </Card>

                {/* ── Metadata card (read-only ΓΕΜΗ data) ─────────────────────────── */}
                {hasAnyMeta && (
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Info className="h-5 w-5" />
                                Στοιχεία ΓΕΜΗ
                            </CardTitle>
                            <CardDescription>
                                Πληροφορίες από το ΓΕΜΗ Open Data — read-only, για reference.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="flex flex-wrap gap-2">
                                {metadata?.gemi && (
                                    <MetaBadge label="Αρ. ΓΕΜΗ" value={metadata.gemi} />
                                )}
                                {metadata?.legalForm && (
                                    <MetaBadge label="Νομική μορφή" value={metadata.legalForm} />
                                )}
                                {metadata?.status && (
                                    <MetaBadge label="Κατάσταση" value={metadata.status} />
                                )}
                                {metadata?.municipality && (
                                    <MetaBadge label="Δήμος" value={metadata.municipality} />
                                )}
                                {metadata?.region && (
                                    <MetaBadge label="Περιοχή" value={metadata.region} />
                                )}
                                {metadata?.incorporationDate && (
                                    <MetaBadge label="Σύσταση" value={metadata.incorporationDate} />
                                )}
                                {metadata?.shareCapital != null && (
                                    <MetaBadge
                                        label="Κεφάλαιο"
                                        value={`${metadata.shareCapital.toLocaleString("el-GR")} ${metadata.currency || "EUR"}`}
                                    />
                                )}
                                {metadata?.autoFilledAt && (
                                    <MetaBadge
                                        label="Auto-filled"
                                        value={new Date(metadata.autoFilledAt).toLocaleString("el-GR")}
                                    />
                                )}
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>
        </DashboardLayout>
    );
}

// ───────────────────────────────────────────────────────────────────────────
// Small helper: read-only label/value badge for metadata
// ───────────────────────────────────────────────────────────────────────────

function MetaBadge({ label, value }: { label: string; value: string }) {
    return (
        <Badge variant="secondary" className="text-xs font-normal py-1 px-2">
            <span className="text-muted-foreground mr-1.5">{label}:</span>
            <span className="font-medium">{value}</span>
        </Badge>
    );
}
