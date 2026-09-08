/** Technical storyboard model only. Production rendering and business state are separate. */
export const SCENES = Object.freeze(['S01', 'S02', 'S03', 'S04']);
export function clamp01(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
export function sceneProgress(scrollY, startY, endY) {
  if (![scrollY, startY, endY].every(Number.isFinite) || endY <= startY) return 0;
  return clamp01((scrollY - startY) / (endY - startY));
}
export function effectiveMotion(preference = 'auto', systemReduce = false) {
  if (preference === 'still') return 'still';
  if (systemReduce || preference === 'reduced') return 'reduced';
  return 'full';
}
export function shouldAnimate({ mode, documentVisible, inViewport, paused = false }) {
  return mode === 'full' && documentVisible === true && inViewport === true && !paused;
}
export function sampleScene(sceneId, progress, mode = 'full', mobile = false) {
  if (!SCENES.includes(sceneId)) throw new RangeError(`Unknown scene: ${sceneId}`);
  const p = clamp01(progress);
  const enabled = mode === 'full';
  const cap = mobile ? 12 : 48;
  const move = (amplitude) => enabled ? -Math.min(amplitude, cap) * p : 0;
  return {
    sceneId, progress: p, textExtraOffset: 0,
    farOffset: move(6), middleOffset: move(12), branchOffset: move(24), nearOffset: move(sceneId === 'S04' ? 12 : 48),
    bookAngle: sceneId === 'S03' ? (enabled ? 7 - 6 * Math.min(1, p * 2) : 1) : 0,
    canDecorate: enabled,
    frameIndex: Math.min(4, Math.round(p * 4)),
  };
}
export function sampleEnvelope({ triggered = false, elapsed = 0, mode = 'full' } = {}) {
  if (!triggered) return { phase: 'closed', lift: 0, flap: 0, paper: 0, readable: false };
  if (mode !== 'full') return { phase: 'readable', lift: -3, flap: 1, paper: 1, readable: true };
  const t = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return {
    phase: t < 120 ? 'lifting' : t < 300 ? 'unfolding' : t < 600 ? 'revealing' : 'readable',
    lift: -3 * clamp01(t / 120), flap: clamp01((t - 120) / 180),
    paper: clamp01((t - 300) / 300), readable: t >= 600,
  };
}
