/**
 * tRPC router for managing the active client profile.
 *
 * The active profile lives as a JSON file at the path resolved by
 * getProfilePath() below. The Python pipeline reads it via client_profile.py,
 * which now watches the file's mtime and auto-reloads when it changes — so a
 * successful upsert here is visible to the next invoice extraction within
 * milliseconds, no container restart needed.
 *
 * Exported procedures:
 *   - get          → read the current profile (or null if file doesn't exist)
 *   - upsert       → write the profile atomically (temp file + rename)
 *   - lookupByVat  → call ΓΕΜΗ Open Data API to auto-populate a profile draft
 *
 * This file is kept isolated from routers.ts to avoid touching the 1700-line
 * main router. Wire it in by adding ONE line to the appRouter; see the patch
 * notes in the conversation.
 */

import { protectedProcedure, router } from "./_core/trpc";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Resolve where the active profile JSON lives. Order:
 *   1. Env var OPTIMUS_CLIENT_PROFILE_PATH (explicit override)
 *   2. Env var OPTIMUS_CLIENT_PROFILE (same as the Python side reads)
 *   3. Default: <cwd>/data/client_profiles/active.json
 *
 * Note: when running in the Node process on the host, cwd is the repo root,
 * so the default resolves to the same path that Docker mounts into the vlm
 * container as /app/data/client_profiles. That gives us write-from-host /
 * read-from-container without any extra plumbing.
 */
function getProfilePath(): string {
    return (
        process.env.OPTIMUS_CLIENT_PROFILE_PATH ||
        process.env.OPTIMUS_CLIENT_PROFILE ||
        path.resolve(process.cwd(), "data", "client_profiles", "active.json")
    );
}

export const clientProfileRouter = router({
    // ── Read the currently active client profile ─────────────────────────────
    get: protectedProcedure.query(async () => {
        const filePath = getProfilePath();
        try {
            const content = await fs.readFile(filePath, "utf-8");
            return { profile: JSON.parse(content), path: filePath };
        } catch (err: any) {
            // ENOENT is not an error — it means "no profile configured yet"
            if (err.code === "ENOENT") return { profile: null, path: filePath };
            throw new Error(`Failed to read client profile: ${err.message}`);
        }
    }),

    // ── Write the active client profile (full replacement) ───────────────────
    // We don't validate the regex patterns here — the Python loader does that
    // gracefully (compiles each pattern in a try/except and logs warnings on
    // bad ones, then ignores them). This keeps the UI simple: paste any pattern,
    // the system fails open with a warning rather than blocking the save.
    upsert: protectedProcedure
        .input((val: unknown) => {
            const v = val as any;
            // Accept either { profile: {...} } or the bare profile object
            const profile = v?.profile && typeof v.profile === "object" ? v.profile : v;
            if (!profile || typeof profile !== "object") {
                throw new Error("Invalid profile payload");
            }
            return { profile };
        })
        .mutation(async ({ input }) => {
            const filePath = getProfilePath();
            const dir = path.dirname(filePath);
            await fs.mkdir(dir, { recursive: true });

            // Write atomically: a partial write would leave the profile corrupted
            // mid-flight, and Python's mtime watcher might pick that up. tmp +
            // rename is atomic on POSIX; Windows is best-effort but close enough
            // for the dev case (production Linux is fine).
            const tempPath = `${filePath}.tmp`;
            await fs.writeFile(
                tempPath,
                JSON.stringify(input.profile, null, 2),
                "utf-8"
            );
            await fs.rename(tempPath, filePath);

            return { success: true, path: filePath };
        }),

    // ── Look up company by ΑΦΜ via ΓΕΜΗ Open Data API ────────────────────────
    // Returns a profile draft that the UI pre-fills into the form. The user
    // then reviews + adds their own patterns + clicks Save (→ upsert).
    lookupByVat: protectedProcedure
        .input((val: unknown) => {
            const v = val as any;
            if (!v?.vat) throw new Error("vat required");
            return { vat: String(v.vat) };
        })
        .mutation(async ({ input }) => {
            const { searchCompanyByVat, companyToProfileDraft } = await import(
                "./businessPortalClient"
                );
            try {
                const company = await searchCompanyByVat(input.vat);
                if (!company) {
                    return {
                        found: false,
                        draft: null,
                        raw: null,
                        message: "No company found in ΓΕΜΗ for this VAT",
                    };
                }
                const draft = companyToProfileDraft(company, input.vat);
                return { found: true, draft, raw: company.raw, message: null };
            } catch (err: any) {
                // Surface the error to the UI rather than throwing, so the user can
                // see "API key not configured" / "Quota exceeded" / etc.
                return {
                    found: false,
                    draft: null,
                    raw: null,
                    message: err.message || "Lookup failed",
                };
            }
        }),
});