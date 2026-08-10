# Studio Flow — Phase 1 UX Research Brief

Scope: research and specification only. No HTML/JS/server files were modified to produce this document. Subject app read in full: `outputs/studio-flow-ui.html` (self-contained vanilla HTML/CSS/JS, Vietnamese UI, 4-step wizard) and `outputs/server.mjs` (Node HTTP server, `/api/status`, `/api/evaluate`, `/api/render`, `/api/qc`, GPT Image 2 + a configurable vision model, local file writes to `generated/`).

---

## A. Sources and key findings

| # | Source / organization | URL | Applicable principle | Concrete implication for Studio Flow |
|---|---|---|---|---|
| 1 | W3C — WCAG 2.2 Quick Reference | https://www.w3.org/WAI/WCAG22/quickref/ | Consolidated AA success criteria: 2.4.7 Focus Visible, 2.5.8 Target Size (Minimum, 24×24px), 1.4.3 Contrast (Minimum), 1.4.11 Non-text Contrast, 4.1.3 Status Messages, 3.3.1/3.3.3 Error Identification & Suggestion, 3.2.6 Consistent Help | The current build has no `:focus-visible` styling, several controls under 24×24px (`.zoom-btn`, `.segment`), toast/status text with no live-region wiring, and no field-adjacent error text — all must be closed for AA in the redesign. |
| 2 | W3C — Understanding SC 2.5.8 Target Size (Minimum) | https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html | Pointer targets need a 24×24 CSS px hit area (or 24px spacing exception) unless inline, essential, or an equivalent larger control exists | `.zoom-btn` (padding 5px 7px, font 9px) and `.segment` (padding 6px 9px, font 10px) in the current UI likely render under 24px tall — redesign must enforce a 24px (ideally 40–44px for a "complete novice" desktop app) minimum hit area on every zoom/compare/step control. |
| 3 | W3C — Understanding SC 4.1.3 Status Messages | https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html | Status/progress/error text must be programmatically exposed via `role="status"`/`role="alert"`/ARIA live regions without stealing focus, and must not be "chatty" | `#toast`, `#analysisProgress`, `#batchSubtitle`, `#serverText` currently update via plain `textContent` with no `aria-live`/`role`, so screen-reader users get zero notice of upload confirmations, batch completion, or connection loss. Redesign must add one polite live region for transient toasts and one for batch/analysis progress, throttled to avoid chatter. |
| 4 | Nielsen Norman Group — Wizards: Definition and Design Recommendations | https://www.nngroup.com/articles/wizards/ | Wizards suit novice/infrequent tasks; show a visible step roadmap; keep navigation strictly sequential; steps must be self-sufficient; allow exit-and-resume | Confirms the fixed 4-step model is the right pattern for a "complete novice" audience. The current step tabs are decorative `<div>`s with no `aria-current="step"` and no resume/save-state affordance if the user closes the tab mid-flow — both should be specified. |
| 5 | Nielsen Norman Group — Progressive Disclosure | https://www.nngroup.com/articles/progressive-disclosure/ | Show only the few most-important options first; defer advanced options behind a clearly labeled secondary action; cap disclosure at 2–3 levels | Applies directly to per-product "add reference angle," per-candidate "change model," and QC score breakdown — these should stay collapsed/secondary so Step 1–4 primary actions remain uncluttered for novices. |
| 6 | Nielsen Norman Group — Error-Message Guidelines | https://www.nngroup.com/articles/error-message-guidelines/ | Non-judgmental tone, specific plain-language description, message placed adjacent to the failing element, preserve user input, offer a concrete recovery action | Current validation errors (`validateFiles`, `/api/render` failures) surface only as a 3.2s toast with no persistent, field-adjacent message — a keyboard/screen-reader user or anyone who looks away misses the error entirely. Redesign requires inline + toast dual delivery. |
| 7 | Nielsen Norman Group — Designing Empty States in Complex Applications: 3 Guidelines | https://www.nngroup.com/articles/empty-state-interface-design/ | Empty states must (1) communicate system status, (2) teach the feature via a pull-revelation hint, (3) provide a direct pathway/CTA to the populating action | The current empty states (`.compare-empty`, `.empty-detail`, `.rail-empty`) already do #1 partially but rarely include a direct CTA button — spec below adds one clear primary action to every empty state. |
| 8 | Nielsen Norman Group — AI for UX: Getting Started | https://www.nngroup.com/articles/ai-ux-getting-started/ | AI output must be treated as a "sidekick," not authority; humans must retain final decision control; AI's fluent output can mislead users into over-trusting it | Directly supports the fixed product requirement that the 5-level score is advisory only and humans approve/download. The redesign must visually demote AI verdicts (e.g., "AI đề xuất," never "AI quyết định") and always foreground the manual Approve/Rerender actions. |
| 9 | IBM Carbon Design System — Progress Indicator pattern | https://carbondesignsystem.com/patterns/progress-indicator-pattern/ | Steppers show completed/current/future steps; label each step with a verb+noun action; use helper text for optional/error states; truncate with tooltip when space-constrained | Confirms the 4-tab stepper header direction is correct; adds the requirement to encode step state as data (`aria-current`, `data-state="done|active|error"`) rather than purely CSS classes, and to give each step a 1–2 word action label (already close: "Ảnh sản phẩm," "Ảnh mẫu," etc.). |
| 10 | Shopify Polaris — Drop zone component | https://polaris.shopify.com/components/selection-and-input/drop-zone | Validate file type/size on drag before drop when possible; give immediate feedback once files are dropped; provide a conventional "choose file" button alongside drag-and-drop; use a critical-status banner for server-side errors | The current dropzones already offer a `<label>`/click fallback, but it's an unfocusable hidden `<input>` inside a non-interactive `<label>` — keyboard users cannot reach the file picker at all. Redesign must replace this with a real, focusable, keyboard-activatable trigger (visually a button) plus drag-and-drop as an enhancement. |
| 11 | Apple Human Interface Guidelines — Progress Indicators | https://developer.apple.com/design/human-interface-guidelines/progress-indicators | Prefer determinate progress when duration is knowable; switch from indeterminate to determinate the moment duration becomes known; don't block the UI unnecessarily | Batch generation is sequential and per-product duration is roughly predictable after the first render — the redesign should show a determinate "product N of M" bar (already present as `#batchBar`) plus a per-product indeterminate spinner only while that single render is in flight, matching this guidance. |
| 12 | Material Design 3 — Accessible design foundations | https://m3.material.io/foundations/accessible-design/overview | State (hover/focus/pressed/error) must be encoded with more than color alone (state layers + visible focus ring); respect `prefers-reduced-motion`; motion should support, not decorate | The current CSS has zero `@media (prefers-reduced-motion: reduce)` handling despite using `transform: translateY`, an infinite-spin loading indicator, and 0.12–0.25s transitions throughout. Redesign must gate all non-essential motion behind this media query. |
| 13 | Adobe Lightroom Classic Help — Browse and compare photos (Compare View) | https://helpx.adobe.com/lightroom-classic/help/browse-compare-photos.html | Professional side-by-side compare locks zoom/pan between both images by default, with an explicit unlock control for independent zoom; a persistent zoom/navigator control complements pointer-driven pan | The current synchronized zoom (`--zoom` CSS var + shared `--ox/--oy` from `pointermove`) is a good start but only works on hover/pointer devices — it has no keyboard equivalent and no persistent pan indicator, both required for a "professional" QC tool per this pattern. |

**Additional coverage notes for required topics not fully carried by a single source above:**
- **Keyboard/focus** — sources 1, 2, 10 together require: visible focus rings on every interactive control, a real focusable upload trigger, and `aria-current="step"` on the active wizard tab.
- **Batch status** — sources 9 and 11 together require a determinate overall bar plus per-item state pills, which the current `#batchList`/`#batchBar` structure already approximates and should keep.
- **Version history / manual override** — sources 4, 8, 13 together require the 4-variant rail to remain, gain timestamps/attempt labels, and keep the human Approve/Rerender action as the only way to finalize a product, matching the "AI as sidekick" principle.

---

## B. Audit of current UI

### Strengths (keep and refine, do not regress)
- Correct fixed 4-step order already implemented: Step 1 products → Step 2 models → Step 3 evaluation → Step 4 batch/QC (`studio-flow-ui.html:53-131`), matching the mandated workflow.
- Novice-oriented Vietnamese copy with a concrete worked example ("váy đỏ + áo trắng + quần đen = 3 sản phẩm," `:90`) and an explicit equation chip ("1 ảnh chính = 1 sản phẩm," `:88`).
- Client-side file validation before upload (`validateFiles`, `:160-168`) checks MIME type, empty files, and minimum 128×128px dimensions — good defensive UX.
- Five-level advisory scoring (`fiveLevel`, `:150`) is non-blocking by design — low scores set `status:'risk'` but never disable rendering, matching the "advisory not blocker" requirement.
- Side-by-side compare stage with a shared `--zoom` CSS variable and pointer-driven synchronized pan across both panes (`renderCompare`, `:285-293`) is a solid technical foundation for professional comparison.
- Batch runs strictly sequentially with per-item state pills and an aggregate progress bar (`runBatch`, `:256-266`), and each product retains up to 4 outputs (original + 3 reruns) via `product.outputs` with a variant rail (`:291`).
- QC breakdown renders a weighted, labeled bar per criterion (`qcRow`, `:294`) instead of a single opaque score, supporting explainability.
- Saved-path copy-to-clipboard (`copySavedPath`, `:312`) closes the loop between AI output and the user's filesystem.

### Usability problems
- **No visible/complete empty-state CTA on Step 1 secondary panel** — the guide card on Step 2 is good, but Step 1's `.product-explain` strip is static text with no dismiss or link to help, offering no pull-revelation per NN/g guideline #2 (source 7).
- **Toasts are the only channel for validation/API errors** (`toast()`, `:151`) and auto-hide after 3.2s with no history — a user who blinks or is mid-drag misses the message permanently, violating NN/g error-message positioning guidance (source 6).
- **Raw absolute filesystem path exposed verbatim** in the QC panel (`.saved`, `:307`, sourced from `output.savedPath` in `server.mjs:134`) — technically correct and must be preserved (server contract), but presented with no plain-language framing for a "complete novice."
- **5-column product grid at fixed `repeat(5,...)`** (`.product-content`, `:31`) forces narrow cards well before 5 products are added, reducing image legibility exactly where product identification matters most.
- **Server-status affordance is a small colored dot** (`.server-dot`, `:19`) — always paired with text (`#serverText`), which is good, but the dot itself likely fails 3:1 non-text contrast against the translucent topbar background at some states.

### Accessibility problems
- **Keyboard trap by omission on both primary dropzones**: `#modelDrop`/`#productDrop` are `<label>` elements wrapping a `display:none` `<input type="file">` (`:67-71`, `:90`). A `display:none` input is removed from the tab order, and `<label>` itself is never a tab stop — keyboard-only users cannot reach the Step 1 or Step 2 upload control at all. This fails WCAG 2.1.1 Keyboard (Level A) for the two most critical actions in the app.
- **No `:focus-visible` styling anywhere in the stylesheet** — reliance on browser defaults only, with several custom control backgrounds (`.segment.active`, `.zoom-btn.active`, `.step-num`) likely to obscure a default outline.
- **No `aria-current="step"` or equivalent on `.step-tab.active`** (`:53-56`) — screen-reader users get no programmatic indication of wizard position, only a CSS color change.
- **No ARIA live regions**: `#toast`, `#analysisProgress`, `#batchSubtitle`, `#serverText`, `#qcStatus` all update via `textContent` with no `role="status"`/`aria-live`, so assistive tech never announces upload confirmation, analysis completion, render completion, or connection state (WCAG 4.1.3, source 3).
- **Undersized interactive targets**: `.zoom-btn` and `.segment` (`:35`) use small padding/font combinations that plausibly render under the 24×24px minimum (WCAG 2.5.8, source 2); needs measurement and correction in the redesign tokens.
- **No `prefers-reduced-motion` handling** anywhere despite `translateY` hover transforms, an infinite-spin CSS animation (`.spinner`, `:40`), and multiple `transition` declarations — fails Material's and W3C's reduced-motion best practice (source 12).
- **Zoom/pan has no keyboard or touch equivalent** — pan is driven exclusively by `pointermove` (`:290`), so keyboard users and touch users (no hover) cannot pan a zoomed comparison image, a core Step 4 workflow action.

### Hierarchy / density issues
- Step 4's three-column layout (`.batch-layout`, 270px / flexible / 320px, `:34`) puts the compare stage in the visually dominant center, which is correct, but the QC actions grid (`.qc-actions`, `:37`) places "Duyệt & tải ảnh" (primary, high-stakes) directly adjacent to "Tạo lại" (secondary) and "Tải bản này" (tertiary) at nearly equal visual weight (same button size/border), diluting the primary action's prominence.
- Step 3's analysis detail crams score grid, recommendation banner, model-choice carousel, and a reason list into one scrolling column (`:100-104`) with little vertical rhythm — no clear resting point between "read the verdict" and "override the model."
- `.equation` chip (`:30`, `:88`) and `.action-count` pill use similar rounded-pill styling to status pills elsewhere, risking visual confusion between "informational chip" and "status indicator" as a design-system role.

### Novice comprehension risks
- The distinction between Step 3's per-product "risk" status and Step 4's per-render "AI: Nên tạo lại" QC verdict uses different vocabulary and different color codes for what is conceptually the same "AI advises caution" message — a first-time user may not connect the two.
- "Sao chép nơi lưu ảnh" (copy saved path) assumes the novice understands filesystem paths; no inline explanation of what the copied value is for.
- The model-choice carousel on Step 3 (`.model-choices`, `:33`) shows only a score number per candidate with no plain-language reason inline, requiring the user to already trust an abstract number.

### Workflow risks
- If the user leaves Step 1 empty and clicks nowhere, the footer already disables the CTA (`renderFooter`, `:212`) — good — but there is no persisted state across a reload/crash; a browser refresh mid-batch silently loses all in-memory `state.products`/`state.models`/generated outputs, which is high-cost after paying for AI renders.
- `runBatch` skips any product whose `outputs.length` is already truthy (`:259-260`) when re-entered, but there is no visible affordance for "resume batch" vs. "start batch" — a user returning to Step 4 after navigating away mid-run has no explicit resume confirmation.
- Rerender reason propagation (`renderOne`, `:272`) only carries `lastQc.rerender_reasons`/`critical_failure_reasons` — if QC itself errored (`qc.error` path, `:275`), a rerender has no structured reasons to send, silently degrading rerender quality without telling the user why.

---

## C. Prioritized requirements

Every item is testable (pass/fail against the shipped HTML/CSS/JS), and none requires backend/API changes.

### P0 — Must ship (blocking accessibility/workflow defects)
1. Every file-selection entry point (Step 1 primary picker, "Thêm sản phẩm," Step 2 model picker, "Thêm góc ảnh") is reachable and activatable using Tab + Enter/Space alone, verified with a keyboard-only pass with no mouse.
2. Every interactive control has a visible focus indicator with at least 3:1 contrast against its adjacent background, verified by tabbing through all 4 steps.
3. All text/icon-only controls that are not decorative meet a minimum 24×24 CSS px hit target (measured via computed box size), including `.zoom-btn`, `.segment`, `.remove-product`, `.add-ref`.
4. All body text meets WCAG 2.2 AA contrast: ≥4.5:1 for normal text, ≥3:1 for large text (≥18.66px bold or ≥24px) and for non-text UI boundaries that convey meaning (status pill borders, score bars).
5. A single polite ARIA live region announces upload confirmations, analysis completion, batch completion, and connection-state changes; a single assertive live region (or `role="alert"`) announces blocking errors — verified no more than one announcement fires per discrete event (no chatter).
6. The active wizard step exposes `aria-current="step"` and each step tab has an accessible name matching its visible label.
7. The 4-step desktop workflow (Steps 1–4, including a populated Step 4 with 5 products/1 selected output) renders with zero `document.body` scrollbar at exactly 1280×720.
8. Below 1280×720, every screen remains fully operable (no cut-off primary actions, no horizontal scroll) down to a defined minimum width in the breakpoint spec (Section E).
9. Product-vs-output comparison supports synchronized zoom from 100% to 300% and pan, operable by pointer, keyboard, and touch (no pointer-only interaction remains for a core QC action).
10. Every screen's error state (upload rejection, evaluate/render/QC API failure) is shown both as a transient toast and as a persistent, dismissible inline message located next to the failing control/product row.

### P1 — Should ship (quality, comprehension, professional polish)
11. Every empty state (no products, no models, no analysis yet, no renders yet) contains: a status sentence, a one-line "why/what's next" hint, and one primary CTA button — no bare icon-only empty states remain.
12. The 4 retained variants per product (original + up to 3 reruns) each show an attempt number and, when available, a one-line summary of what changed (from `rerenderReasons`), not just a thumbnail.
13. The Step 4 QC action group visually distinguishes the primary action ("Duyệt & tải ảnh") from secondary/tertiary actions by size, color weight, or position — not by border color alone.
14. Batch queue rows and Step 3 analysis rows use one consistent vocabulary/status-pill set for "AI flags a risk," shared between Step 3 input evaluation and Step 4 output QC.
15. The saved-path affordance shows a human-readable label ("Đã lưu trong thư mục generated") with the full OS path available on hover/expand, not as the primary visible string.
16. `prefers-reduced-motion: reduce` disables non-essential transform/opacity transitions and swaps the infinite spinner for a static/low-motion equivalent, verified by toggling the OS setting.
17. All motion-based hover affordances (e.g., `translateY` lift) have a non-motion fallback cue (border/shadow change) so meaning isn't conveyed by motion alone.
18. Model-choice cards on Step 3 show a one-line plain-language reason (from `evaluation.risks`/`recommended_reference_requirements`) alongside the numeric score, not the number alone.

### P2 — Nice to have (future polish, non-blocking)
19. Reload-survivability messaging: if `state` would be lost on refresh, a `beforeunload` confirmation warns the user before leaving Step 3/4 with unsaved/un-downloaded approved outputs.
20. A lightweight "resume batch" vs. "start batch" label distinguishes re-entering Step 4 with partial outputs from a fresh run.
21. Density options (comfortable/compact) for the Step 1 product grid so 1–2 products aren't rendered at the same narrow card width as 5.
22. A visual legend or tooltip explaining what each of the 5 advisory levels means the first time a user encounters it.

---

## D. Information architecture and exact 4-step model

Global rule: **Step 1 = product images, Step 2 = model images**, fixed and non-negotiable per product requirement.

### Step 1 — Ảnh sản phẩm (Product images)
- **Purpose**: capture 1–5 primary product images, each becoming one independent product, with optional extra reference angles per product.
- **Primary action**: "Chọn cùng lúc 1–5 ảnh sản phẩm" (bulk picker) → auto-creates N product cards.
- **Minimum user actions**: 1 click to open picker + 1 file-dialog confirmation = 2 actions to produce up to 5 products.
- **Layout regions**: intro/eyebrow + count chip (top) → explainer strip → picker or product-card grid (main) → sticky action bar (bottom, "Tiếp tục: Chọn ảnh mẫu →").
- **Progressive disclosure**: "Thêm góc ảnh" (extra reference angles) and "Xóa sản phẩm" stay secondary, per-card, collapsed until the card exists — never shown before the primary image is picked.
- **Validation**: file type (JPEG/PNG/WEBP), non-empty, ≥128×128px, ≤5 products per batch, ≤8 files per product (1 primary + up to 7 extra angles) — all enforced client-side before proceeding.
- **States**: *empty* (single centered picker with worked example) → *loading* (per-file validation, near-instant, no spinner needed under ~300ms) → *success* (product grid populated, count chip updates) → *error* (rejected file toast + inline reason, picker remains usable, no products lost).
- **Back-navigation**: none (first step); "Chọn lại" pattern not needed since removal is per-card.
- **Data preservation**: adding more products (up to 5) must never clear existing cards; removing one card must not affect others' state or selection.

### Step 2 — Ảnh mẫu (Model images)
- **Purpose**: capture 1–10 shared model candidate images used across all products; AI will select the best match per product independently.
- **Primary action**: "Chọn ảnh người mẫu" (bulk picker, up to 10).
- **Minimum user actions**: 1 click + 1 file-dialog confirmation = 2 actions.
- **Layout regions**: intro + count chip (top) → two-column: dropzone/thumbnail grid (left, dominant) + static "good photo" guide card (right, dismissible/collapsible on narrow viewports) → sticky action bar with back + "Phân tích N sản phẩm →".
- **Progressive disclosure**: the guide card's 3 tips are visible by default (novice audience, low cost to show) but must collapse first under the 1050px breakpoint since it is non-essential.
- **Validation**: same file rules as Step 1; cap at 10; primary CTA disabled until ≥1 model AND ≥1 product AND API ready.
- **States**: *empty* (picker + guide) → *loading* (validation) → *success* (thumbnail grid with numbered labels) → *error* (toast + inline reason; "Chọn lại" always available).
- **Back-navigation**: "← Ảnh sản phẩm" returns to Step 1 without clearing Step 2 data.
- **Data preservation**: switching back to Step 1 and forward again must retain the model set exactly as uploaded.

### Step 3 — Kiểm tra ảnh đầu vào (Input evaluation)
- **Purpose**: run AI advisory evaluation per product (best model match + 5-level score), non-blocking.
- **Primary action**: "Phân tích N sản phẩm →" — one click starts sequential evaluation of every product against every model.
- **Minimum user actions**: 1 click to start; 0 further clicks required to reach a usable Step 4 (model override is optional).
- **Layout regions**: intro + progress chip (top) → two-column: product queue with status pills (left) + selected-product detail: score grid, recommendation banner, model-choice carousel, reason list (right, scrollable) → sticky action bar ("← Ảnh mẫu" / "Tạo N ảnh bằng AI →" or "Phân tích lại sản phẩm lỗi").
- **Progressive disclosure**: full risk/reason list and alternate-model carousel are visible only for the currently selected product, not all products at once — avoids a wall of numbers.
- **Validation**: none blocks progression — a low or failed score never disables the render CTA; only an unrecoverable per-product API error blocks that single product (others proceed).
- **States**: *empty* (pre-analysis placeholder) → *loading* (per-product "evaluating" pill + spinner in detail pane, queue updates live) → *success* (score grid + 5-level label + recommendation) → *error* (per-product error pill + inline message + "Phân tích lại" retry scoped to failed items only) → *risk* (fifth state distinct from success/error: AI flags concern but the product remains renderable).
- **Back-navigation**: "← Ảnh mẫu" available except while `analyzing` is in progress (explicitly disabled with a reason, not silently ignored).
- **Data preservation**: switching selected product in the queue never re-triggers analysis; manual model overrides persist across navigation until the user changes them again.

### Step 4 — Tạo ảnh & QC (Batch generate + human QC)
- **Purpose**: one-click sequential generation for all products, each followed by AI QC advice, with human-in-the-loop approve/rerender/download.
- **Primary action**: "Tạo N ảnh bằng AI →" (from Step 3) starts the batch; within Step 4, "Duyệt & tải ảnh" is the terminal per-product action.
- **Minimum user actions**: 1 click to start the whole batch; per product, 1 click to approve (or up to 3 additional clicks to rerender first).
- **Layout regions**: three-column — batch queue with progress bar (left) + compare stage with toolbar (source toggle, zoom controls) and variant rail (center, dominant) + QC panel with score breakdown and action buttons (right).
- **Progressive disclosure**: QC score sub-bars (6 weighted criteria) are visible by default once available (novice benefits from seeing *why*), but raw JSON/technical fields never surface.
- **Validation**: Approve/Download disabled until an output exists; Rerender disabled at 4/4 attempts used or while busy; Copy-path disabled until a saved path exists.
- **States**: *empty* ("ảnh sẽ xuất hiện tại đây" placeholder with CTA context) → *loading* (rendering spinner in compare stage, then "Đang QC" in QC panel) → *success* (compare populated + QC score + pass verdict) → *error* (render/QC failure surfaced per-product with retry) — all four states must be distinguishable at a glance via the batch queue status pill.
- **Back-navigation**: "← Kết quả kiểm tra" returns to Step 3, disabled while `batchBusy`, with a visible reason (not just a disabled button).
- **Data preservation**: navigating back to Step 3 and forward again must not re-run or discard any completed/partial outputs; selected product/output/zoom/compare-source persist across a step round-trip.

---

## E. Visual design system

### Design direction
Warm, editorial "creative studio" tone (paper/ink palette already present is a good foundation) elevated to premium production-tool density: more deliberate spacing rhythm, stronger primary/secondary action contrast, and explicit state layers instead of ad hoc color reuse.

### Tokens

**Color (contrast intent, not just hex)**
- `--ink` (#191816) on `--paper`/`--card`: body text, must hold ≥7:1 (exceeds AA, supports AAA-adjacent legibility for long QC copy).
- `--muted` (#726e67-class): secondary text, must be tuned to guarantee ≥4.5:1 on both `--paper` and `--card`; verify at design time, not by eye.
- `--accent` (product/primary highlight): used for active states and the equation chip; must hold ≥4.5:1 against `--accent-soft` background when used as text, and ≥3:1 as a non-text boundary (active border/ring).
- Status family (`--green`/`--amber`/`--red` + `-soft` backgrounds): each pairing must independently pass 4.5:1 text contrast; never the sole differentiator — always paired with a text label and, where feasible, an icon/shape (already partially true via status-pill text).
- Focus ring: a new dedicated token (e.g., `--focus`), high-contrast (≥3:1 against every adjacent background it appears on), 2px minimum, offset from the control edge so it isn't clipped by `overflow:hidden` containers.

**Type scale**: retain the existing compact scale (11/12/13/14/16/18/19/25px) but formalize it as named steps (caption, small, body, label, subtitle, title, display) so new components reuse rather than invent sizes.

**Spacing scale**: base unit 4px; formalize the observed ad hoc values (5/7/8/9/10/11/12/13/14/16/18/24px) down to a documented 4/8/12/16/24/32 scale, allowing the existing 5/7/9/etc. only inside dense components (pills, mini-buttons) where documented as an exception.

**Radii**: keep `--radius` (18px) for cards; define secondary tokens — 10–12px for buttons/inputs, 6–8px for chips/pills/thumbnails — matching values already in use, just formalized.

**Shadows**: keep the existing soft, low-opacity card shadow as the single elevation token for resting cards; add one lighter "hover/active" elevation step for interactive cards (product cards, variant thumbnails) so state changes are perceivable without motion alone.

**Borders**: `--line` for all resting dividers/card borders; a new `--line-strong` token (higher contrast) reserved for focus-adjacent or error-adjacent borders so those states remain visible against the muted default palette.

### Density
Desktop-first, information-dense (production tool, not a marketing page): tighten Step 1 product-grid column count to scale with actual product count (1–2 products should not render at 5-column width) rather than a fixed 5-column track.

### Image treatment
Consistent `object-fit` policy: `cover` for identity thumbnails (model/product grid thumbnails, where cropping is acceptable), `contain` for anything used for QC judgment (compare stage, product-preview) where no pixel may be cropped out of view. Checkerboard/neutral backdrop behind `contain` images (already present in `.compare-pane`) should be reused everywhere a QC-relevant image can have transparent or off-aspect padding.

### Responsive breakpoints
- **≥1280px** (primary target): full 3-region layouts, no body scroll at 1280×720 exactly.
- **1051–1279px**: same layouts, workspace allowed to scroll vertically (as today) while columns hold.
- **721–1050px**: single-column stacking for upload/analysis layouts, guide/help panels collapse behind a disclosure toggle instead of disappearing outright, batch layout drops to 2 columns.
- **≤720px**: full single-column stacking; the compare stage becomes an explicit toggle/swipe between "Sản phẩm gốc" and "Ảnh AI" (replacing the current silent `display:none` of the first pane) so the core comparison capability is never fully lost, only re-presented.

### Keyboard/focus behavior
- Full tab order follows visual reading order within each step; no positive `tabindex` values.
- Every dropzone/upload trigger is a real `<button>` (or a focusable element with `role="button"` and keydown handling) — never a bare `<label>` around a `display:none` input.
- Zoom presets (`Vừa khung`/100%/150%/200%) and the zoom slider are reachable and operable via keyboard (arrow keys adjust the slider per native `<input type=range>` behavior).
- A documented keyboard equivalent for pan-while-zoomed (e.g., arrow keys nudge the focused compare pane's origin) replaces pointer-only panning.

### ARIA / live-region policy
- One `role="status" aria-live="polite" aria-atomic="true"` region hosts toast-equivalent confirmations (upload counts, batch/analysis completion).
- One `role="alert"` (implicit assertive) region hosts blocking errors (API failures, validation rejections) — distinct from the polite region so errors are never missed but successes never interrupt.
- Progress text (`Đang phân tích · N giây`, elapsed timers) is explicitly **excluded** from live-region announcements (ticking every second would be textbook "chatty") — only start and completion are announced.
- `aria-current="step"` on the active step tab; `aria-current` removed on completed/future tabs.
- Status pills carry an accessible name equal to their visible text (already true since they render text, must remain true after redesign).

### Reduced-motion behavior
- Wrap all `transform`/`transition`/`animation` declarations that are purely decorative (hover lift, spinner rotation speed, toast slide) in `@media (prefers-reduced-motion: no-preference)` scoping, or provide an explicit `prefers-reduced-motion: reduce` override that sets `transition: none` / caps the spinner to a static "loading" glyph with the same semantic meaning.
- Functional motion (progress bar width animating to reflect real progress) may keep a very short, non-essential transition but must not be the sole indicator of change (the numeric "N/M" label already covers this).

### Vietnamese microcopy rules
- Second-person-neutral, respectful register consistent with existing copy ("anh" used consistently as the addressed user — keep this register uniform across every new string; do not mix with a different pronoun).
- Verb-first action labels on all primary buttons ("Chọn ảnh…", "Phân tích…", "Tạo ảnh…", "Duyệt & tải ảnh…"), matching the Carbon verb+noun stepper guidance (source 9) and the existing app's own convention.
- No untranslated technical jargon in user-facing strings (e.g., replace raw filesystem paths as the primary visible string per requirement P1-15); technical/debug detail may exist in a `title` tooltip attribute only.
- Numbers and counts always paired with a unit word ("N ảnh," "N sản phẩm," "N/4 phiên bản") — never a bare number as the only content of a status string, for both clarity and screen-reader sense.
- Error strings follow NN/g's four-part structure (source 6) translated into Vietnamese: plain description of what happened, no blame language, adjacent placement, one concrete next step.

---

## F. Comparison and QC specification

### Side-by-side source/output comparison
- Two-pane layout retained: left = source (toggle between "Sản phẩm gốc"/"Người mẫu gốc"), right = AI output for the currently selected variant.
- Each pane keeps a persistent label chip (already present) identifying which image and which variant number is shown.
- Panes must remain equal-width and equal-aspect-handling (`object-fit:contain` on a neutral checkerboard backdrop) so no image is implicitly cropped during judgment.

### Synchronized zoom and pan
- Zoom is a single shared value (already implemented as one `--zoom` CSS custom property) applied identically to both panes — never independently zoomable, matching the Lightroom "locked" compare mode (source 13) since Studio Flow's use case is fidelity-checking, not independent inspection.
- Pan follows pointer position on hover (existing behavior) **plus** a keyboard equivalent: when a pane has focus and zoom > 100%, arrow keys nudge the shared pan origin in fixed increments; Home resets to center.
- On touch devices, pan is driven by drag-within-pane (touch-move) since hover doesn't exist; this must be specified as a required interaction, not an accepted gap.

### Zoom presets
- Presets retained: "Vừa khung" (fit, =100% baseline), 100%, 150%, 200%, plus the continuous slider already scoped 100–300% — slider and presets stay mutually in sync (moving the slider deactivates preset button highlighting unless it lands exactly on a preset value, as today).
- Minimum 24×24px (ideally 40×40px, given "novice, minimum clicks" and desktop mouse-first usage) hit area on every zoom preset button.

### Variant rail
- Continues to show up to 4 thumbnails (original + up to 3 reruns) with the selected variant visually distinguished (existing accent border/shadow pattern).
- Each thumbnail gains an attempt label ("Bản 1," "Bản 2"…, already present as a number chip) and, space permitting, a one-line reason summary sourced from that attempt's `rerenderReasons` so the rail also functions as a lightweight version history, not just a picker.

### AI QC presentation
- QC verdict is always framed as advisory language ("AI đề nghị xem kỹ," never "AI từ chối" / "AI quyết định"), consistent with the human-in-the-loop principle (source 8).
- The 6-criterion weighted breakdown (silhouette, construction detail, length/proportion, color/material, model-pose preservation, scene/camera preservation) remains visible by default under the top-line score, each with its own labeled bar — this is the "explainability" layer that lets a novice trust or challenge the score.
- A single top-line fidelity score plus 5-level label anchors the panel, matching the Step 3 scoring vocabulary exactly (shared `fiveLevel` semantics) so users learn one mental model for the whole app.

### Reason/action mapping
- Each QC reason string is optionally clickable/hoverable to reveal which criterion it relates to (mapping `critical_failure_reasons`/`rerender_reasons` to the specific bar above), closing the gap where today reasons are a flat list disconnected from the score bars.
- When QC itself errors (no scoreable result), the panel explicitly states that automated QC is unavailable for this attempt and that the user's own visual comparison is the basis for the decision — never silently blank.

### Manual approve/download
- "Duyệt & tải ảnh" remains the single, visually primary action (largest, highest-contrast button) that both records approval and downloads in one click, per the existing combined semantics — this satisfies "minimum clicks."
- "Tải bản này" (download without approving) remains available as a clearly secondary action for users who want the file before committing to a decision.
- Approval state is reflected immediately in the batch queue's status pill so the left-column queue always reflects true product-level state.

### Rerender counter
- Rerender button always displays remaining attempts out of 3 ("Tạo lại (còn N)"), disabled at 0 remaining with the disabled state explaining why (tooltip/inline note: "Đã dùng hết 3 lần tạo lại"), not just a grey button.
- Each rerender's guidance to the AI (existing `rerenderReasons` payload) is unchanged (server contract preserved); the UI addition is only to display that reasoning back to the user before/after the rerender fires.

### Saved-path feedback
- Primary visible string: a friendly, translated confirmation ("Đã lưu vào thư mục generated trên máy"). Full path remains available (title attribute or expandable secondary line) and the existing one-click copy-to-clipboard action is preserved unchanged.

### Batch queue status
- Left-column queue keeps one row per product with thumbnail, name, variant count, and a status pill drawn from the same 8-state vocabulary already defined in `statusMeta` (waiting/evaluating/analyzed/risk/rendering/qc/ready/approved/error) — spec requires this vocabulary be visually consistent with Step 3's pills (shared color/label mapping) to resolve the "two vocabularies for one concept" issue identified in the audit.
- Aggregate progress bar reflects completed/total products; text label states counts in words ("N/M sản phẩm đã tạo"), never a bare percentage alone.

### Error recovery
- Any per-product render/QC failure is scoped to that product only — the batch continues to the next product automatically (existing `runBatch` try/catch behavior preserved), and the failed product's row exposes a retry action scoped to itself.
- A failed product's error message is human-readable (server error message passed through, per existing `error.message` handling) and persists in the row (not just a toast) until the user retries or dismisses it.

---

## G. Measurable acceptance checklist

- [ ] Full 4-step desktop workflow (Steps 1–4, Step 4 populated with 5 products and at least 1 rendered output) fits exactly 1280×720 with **zero** `document.body` scrollbar.
- [ ] All 4 screens remain fully operable and legible at defined breakpoints below 1280×720 (1050px, 720px), with no horizontally clipped primary actions.
- [ ] Entire workflow — Step 1 through Step 4 approve/download — is completable using only Tab, Shift+Tab, Enter, Space, and Arrow keys, with no mouse.
- [ ] Every focusable element shows a visible focus indicator (≥3:1 contrast, ≥2px) at every point in the tab order, including inside `.compare-pane`, `.variant`, and step tabs.
- [ ] All body text and UI-boundary colors meet WCAG 2.2 AA: ≥4.5:1 normal text / ≥3:1 large text / ≥3:1 non-text meaningful boundaries, verified against both `--paper` and `--card` backgrounds.
- [ ] Upload confirmations, analysis completion, and batch completion are announced via one polite ARIA live region; errors via one assertive region/`role="alert"`; per-second elapsed-time ticks are **not** announced (no chatter).
- [ ] Step 1 accepts exactly 1–5 primary product images in one bulk pick, creating exactly that many independent product records; each product card supports adding multiple additional reference angles.
- [ ] Step 2 accepts 1–10 shared model images in one bulk pick, reused across every product without re-upload.
- [ ] Step 4's batch generation starts with exactly one user click and processes all products sequentially without further required input.
- [ ] Step 3 scoring renders all 5 advisory levels (Xuất sắc/Tốt/Có thể thử/Rủi ro cao/Không phù hợp) and a product scored in the two lowest levels can still be sent to Step 4 rendering without any additional override click beyond what a normal-scoring product requires.
- [ ] Step 4 compare stage supports synchronized zoom from 100% to 300% (slider) plus 100/150/200% presets, applied identically to both source and output panes, operable by pointer, keyboard, and touch.
- [ ] Each product retains up to 4 output variants (original + up to 3 reruns) simultaneously selectable from a variant rail; the rerender action is disabled exactly at the 4th variant with a visible reason.
- [ ] "Duyệt & tải ảnh" both records human approval and downloads the file in one click; the saved local path is copyable via one click, with a human-readable confirmation shown as the primary text.
- [ ] Every screen defines and visually distinguishes its own loading, error, success, and empty states (no state renders as a blank/undefined area).
- [ ] All existing `/api/status`, `/api/evaluate`, `/api/render`, `/api/qc` request/response contracts, the `gpt-image-2` model id, the vision-model env var, and server-side secret handling (`OPENAI_API_KEY` never sent to or rendered in the client) are unchanged and unexposed in the redesigned UI.

---

## Implementation mandate

The three most important redesign decisions for Phase 2:

1. **Fix keyboard reachability of the two primary upload triggers first.** Replacing the `<label>`-around-`display:none`-`<input>` pattern with a real focusable, keyboard-activatable control on `#modelDrop`/`#productDrop` (while keeping drag-and-drop as an enhancement) is the single highest-severity, highest-leverage change — without it, the entire workflow is unusable without a mouse, which is both a WCAG 2.1.1 Level A failure and a direct blocker to the "keyboard-only completion" acceptance item.

2. **Treat AI output as advisory everywhere, consistently, in both vocabulary and visual weight.** Unify Step 3's input-evaluation status language with Step 4's output-QC status language into one shared vocabulary/color mapping, and keep the human Approve/Rerender action visually dominant over any AI verdict text — this is what makes the fixed "five advisory levels, not a binary blocker" and "AI QC as advice" product requirements actually legible to a complete novice rather than merely technically true.

3. **Make the synchronized zoom/pan comparison fully device-independent.** Add a keyboard-operable pan equivalent and a touch-drag equivalent to the existing pointer-hover-only pan, and keep zoom locked (never independent) between the source and output panes — this is the core "precise synchronized zoom" and "professional side-by-side comparison" deliverable, and today it silently degrades to zoom-only (no pan) for every non-mouse user, which undermines the app's central QC value proposition.
