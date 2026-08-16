# PersonaSim visual system

The two ImageGen concepts in `docs/design/` are the visual source of truth for the MVP:

- `chat-screen-concept.png` — primary chat, state rail, schedule mutation and proactive message.
- `character-editor-concept.png` — structured editing, field locks, provenance and version controls.

## Direction

PersonaSim is a quiet editorial simulation studio rather than a sci-fi dashboard. It uses open rails, lists and document-like tables. Cards are reserved for actual grouped content; surfaces are not nested for decoration.

## Tokens

| Role          | Value     |
| ------------- | --------- |
| Canvas        | `#f7f8f7` |
| Surface       | `#ffffff` |
| Primary ink   | `#171a1c` |
| Secondary ink | `#667078` |
| Hairline      | `#dde1df` |
| Accent        | `#f04b23` |
| Accent soft   | `#fff0e9` |
| Positive      | `#5da85b` |
| Informative   | `#5c8bd8` |
| Warning       | `#d99b35` |

Use an 8 px spacing grid, 6–12 px control radii, and shadows only for transient overlays. Chinese UI text uses `Inter`, `Noto Sans SC`, `PingFang SC`, `Microsoft YaHei`, sans-serif; editorial names may use a Song/Ming fallback.

## Signature motif

A one-pixel thread with a small circular node connects cause and effect: a user invitation to a schedule change, an activity event to a proactive message, or a selected field to its provenance. It is semantic, not decorative.

## Responsive model

- `>= 1180 px`: full navigation, main surface and contextual inspector.
- `760–1179 px`: compact navigation; inspector becomes a drawer.
- `< 760 px`: bottom navigation, one-column content and modal/drawer secondary surfaces.

## Interaction inventory

- Navigation routes, selected state and keyboard focus are visible.
- Forms expose loading, validation, autosave and published states.
- Schedule changes animate only opacity/transform and honor reduced motion.
- Chat composer, editor actions, tabs, timeline filters and developer clock controls are functional.
- Icons use one consistent 1.75 px outline family and include accessible labels.
