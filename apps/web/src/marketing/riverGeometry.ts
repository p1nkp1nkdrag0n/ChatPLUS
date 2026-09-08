// Coordinates follow the streambed in forest.webp. Both layers share this path
// and its artwork frame, including when that frame is cropped on small screens.
export const RIVER_PATH = [
  "M .788 .447",
  "C .773 .467 .791 .494 .775 .517",
  "C .759 .540 .744 .552 .752 .578",
  "C .768 .605 .777 .628 .752 .654",
  "C .728 .678 .712 .693 .722 .716",
  "C .737 .742 .727 .767 .701 .792",
  "C .675 .817 .690 .845 .661 .873",
  "C .630 .903 .584 .949 .535 1.025",
  "L .733 1.025",
  "C .761 .969 .794 .935 .790 .901",
  "C .783 .871 .787 .843 .799 .813",
  "C .816 .775 .815 .748 .806 .721",
  "C .797 .695 .813 .666 .812 .638",
  "C .810 .607 .818 .578 .805 .551",
  "C .793 .527 .805 .510 .809 .489",
  "C .812 .470 .803 .455 .797 .447 Z",
].join(" ");

// A slight inward fade lets the painted rock edge remain visible instead of
// drawing an opaque cutout. This is a technical mask, not a replacement artwork.
export const RIVER_EDGE_MASK = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="none"><defs><filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="3"/></filter></defs><g filter="url(#soft)"><path d="${RIVER_PATH}" transform="scale(1000)" fill="white"/></g></svg>`,
)}")`;
