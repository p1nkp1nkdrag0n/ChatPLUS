import { useId, useRef } from "react";
import type { MotionMode } from "../hooks/useMotionPreference";
import { Layer } from "./Scene";
import { WaterRipple } from "./WaterRipple";
import { RIVER_EDGE_MASK, RIVER_PATH } from "./riverGeometry";
import "./river.css";

export function RiverSurface({ mode }: { mode: MotionMode }) {
  const clipId = `river-${useId().replaceAll(":", "")}`;
  const frame = useRef<HTMLDivElement>(null);
  const clipping = {
    clipPath: `url(#${clipId})`,
    maskImage: RIVER_EDGE_MASK,
    maskSize: "100% 100%",
  };
  return (
    <div className="river-artwork-frame" ref={frame}>
      <svg className="river-geometry" aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={clipId} clipPathUnits="objectBoundingBox">
            <path d={RIVER_PATH} />
          </clipPath>
        </defs>
      </svg>
      <Layer
        name="S02-WATER"
        src="s02/water.webp"
        className="layer-river"
        style={clipping}
      />
      <WaterRipple mode={mode} clipping={clipping} artworkFrame={frame} />
      <Layer name="S02-BANK" src="s02/bank.webp" className="layer-bank" />
    </div>
  );
}
