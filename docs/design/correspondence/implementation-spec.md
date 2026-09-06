# Correspondence UI implementation specification

This specification translates the approved visual concepts into code-native React UI. The PNGs in this directory are references only; no screenshot text or controls may be shipped as application UI.

## Reference screens

- `mailbox-concept.png`: mailbox filters, open letter rail, unopened envelope, and date-based transit state.
- `compose-concept.png`: draft fields, paper choice, live preview, and seal confirmation.
- `open-concept.png`: selectable reply text, one-to-one exchange history, and next-letter action.

## Visual system

- Canvas: the existing neutral `--canvas`; surfaces stay white. Paper may use an extremely subtle fiber texture made with CSS, but the application background must not become cream or beige.
- Ink: existing near-black `--ink`, `--ink-soft`, and `--muted`. Metadata never competes with the letter body.
- Accents: `--accent` for the primary write/seal action, postal blue for transit/postmarks, and sage only for delivered/read completion.
- Typography: UI chrome uses `--font-ui`; page titles and letter content use `--font-editorial`. Letter body targets 17–19 px, 1.9–2.05 line height, and a readable line length of 34–46 Chinese characters.
- Geometry: thin rules, small existing radii for controls, and no nested card grid. The paper/envelope is the single tactile focal surface.
- Motion: one short envelope reveal after the server has successfully opened a reply. It must be skippable and disabled under `prefers-reduced-motion`.

## Component families

- `CorrespondenceNavItem`: one outline `Mail` icon, using the existing navigation anatomy and active rail.
- `MailboxFilter`: accessible tabs for 全部 / 收件 / 在途 / 已寄 / 档案. These are controls, not decorative pills.
- `LetterListRow`: direction icon, correspondent, local display date, state label, and optional arrival indicator. An unopened agent reply never renders a preview.
- `TransitProgress`: date-derived progress line with dispatched, current, and due labels; no ticking countdown.
- `EnvelopePanel`: sealed/delivered state with a code-native open button and restrained postal mark.
- `PaperTemplateSelector`: exactly three reusable treatments—棉纸, 素笺, 夜蓝—with a real radio group.
- `LetterPaper`: selectable text surface shared by compose preview and open view.
- `ExchangeTimeline`: one-to-one chronological rail. Use thin lines and event dots rather than cards.
- `SealConfirmation`: explicit immutable-after-seal warning and the fixed five-day expected date.

## Route and state inventory

- `/characters/:characterId/correspondence`: mailbox and thread list, filterable without re-fetching plaintext.
- `/characters/:characterId/correspondence/compose`: create or resume the only editable draft.
- `/letters/:letterId`: draft editing, sealed transit detail, delivered envelope, or opened reading view according to safe server state.
- `/correspondence/threads/:threadId`: complete exchange timeline; it may reuse the detail layout.

React Query keys are exactly `["correspondence", agentId]`, `["letter", letterId]`, and developer-only `["temporal-tasks", agentId]`. Seal and open are pessimistic mutations followed by invalidation; plaintext from `open` is held only in the mounted reading route and is never inserted into mailbox data.

## Allowed primary-screen copy

Mailbox: 书信, 写一封信, 全部, 收件, 在途, 已寄, 档案, 已抵达，等待启封, 启封阅读.

Compose: 返回书信, 写一封信, 主题（可选）, 正文, 棉纸, 素笺, 夜蓝, 封缄后将无法修改, 预计五天后抵达, 保存草稿, 确认封缄并寄出.

Reading: 返回书信, 与 {角色名} 的往来, 复制正文, 清晰阅读, 写下一封信, 附言.

Dynamic dates, postmarks, correspondent names, transport messages, validation feedback, and accessible-only labels may be added where required by real state. Do not add metrics, search, badges, decorative eyebrow copy, AI-writing controls, a public-share action, or a second competing call to action.

## Responsive behavior

- Desktop at 1440×1000: preserve the narrow application sidebar. Mailbox is a list/detail split; compose is form/preview; reading is paper/timeline.
- Tablet: collapse the secondary detail into the selected route while keeping filters and primary action visible.
- Mobile at 390×844: use the existing bottom navigation, a single-column list or route, sticky but non-obscuring compose actions, and a full-width readable letter. No horizontal overflow; paper treatment cannot reduce body text contrast.

## Accessibility and privacy gates

- All letter text remains real selectable text with semantic headings and paragraphs.
- Every icon-only control has an accessible name. Tabs, templates, and confirmation choices are keyboard operable.
- Focus is moved to the opened letter heading only after a successful open response.
- `prefers-reduced-motion` bypasses the reveal and renders the body immediately.
- Unopened reply plaintext must not exist in mailbox/detail API responses, query cache, DOM, logs, `data-*` attributes, or developer tools projections.

## Relationship archive and keepsakes (R2/R3)

Approved concept reference:
`docs/design/correspondence/archive-keepsake-concept.png`.

- Use a two-column archive at wide sizes: the paginated chronological record
  remains primary; the sparse keepsake cabinet and selected provenance remain
  secondary. Collapse to one reading order on mobile: archive, cabinet,
  provenance, share preview.
- Archive entries must open their durable source. Group by month or character
  period and fetch by cursor; never hydrate the entire relationship history.
- Keepsakes are objects, not reward tiles. Show at most four to six in one
  low-density shelf/section, with title, effective date, and an explicit
  “来自哪次经历” affordance.
- Provenance distinguishes confirmed experience, opened letter, reflection,
  and relationship milestone. It may show a short safe projection, never raw
  hidden evidence or unopened letter plaintext.
- Share Composer defaults to envelope, postmark, elapsed waiting days, and one
  chosen keepsake. “正文摘录” is off by default and requires a deliberate user
  action plus a redaction preview.
- Export is local PNG only. The preview must say that no public URL is created,
  and no upload/share action may happen implicitly.
- Continue the correspondence color and type system: navy ink, burnt-orange
  postal accent, muted sage completion; warm paper only within artifacts.
  Avoid a bento dashboard, gallery-wall density, gradients, or glass effects.
