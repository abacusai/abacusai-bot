/** Dev-only pose board, optical sizes, accessories, and interruptible rehearsal. */
import { useState } from "react";
import { BotAvatar } from "#renderer/components/bot-avatar";
import { AVATAR_SHAPES, AVATAR_ACCESSORIES, AVATAR_PALETTE, LIFECYCLE_MOODS, REACTION_MOODS, type AvatarMood } from "#renderer/lib/bots/avatar";

const moods = [...LIFECYCLE_MOODS, ...REACTION_MOODS];
const sizes = [16, 24, 32, 44, 72, 160];
export const AvatarGallery = () => {
  const [size, setSize] = useState(44);
  const [animate, setAnimate] = useState(false);
  const [mood, setMood] = useState<AvatarMood>("idle");
  return <div className="space-y-8" data-avatar-gallery>
    <div className="flex flex-wrap gap-3">
      {sizes.map(s => <button key={s} onClick={() => setSize(s)} aria-pressed={size === s}>{s}px</button>)}
      <button onClick={() => setAnimate(!animate)} aria-pressed={animate}>{"Motion" /* i18n-ignore: dev gallery */}</button>
      {moods.map(m => <button key={m} onClick={() => setMood(m)} aria-pressed={mood === m}>{m}</button>)}
    </div>
    <div data-avatar-rehearsal className="flex flex-wrap items-end gap-5 p-5">
      {AVATAR_SHAPES.map((shape, i) => <BotAvatar key={shape} look={{ shape, color: AVATAR_PALETTE[i % AVATAR_PALETTE.length]!.hex, accessory: "none" }} mood={mood} size={72} animate={animate} />)}
    </div>
    <div data-avatar-board style={{ display: "grid", gridTemplateColumns: `80px repeat(${moods.length}, ${Math.max(50, size + 12)}px)`, gap: 8, width: "max-content", padding: 16, background: "var(--background)" }}>
      <span />{moods.map(m => <span key={m} className="text-center text-[10px]">{m}</span>)}
      {AVATAR_SHAPES.map((shape, i) => <div key={shape} style={{ display: "contents" }}><span className="self-center text-xs">{shape}</span>{moods.map(m => <div key={m} className="flex items-center justify-center" style={{ height: Math.max(50, size + 12) }}><BotAvatar look={{ shape, color: AVATAR_PALETTE[i % AVATAR_PALETTE.length]!.hex, accessory: "none" }} mood={m} size={size} animate={animate} /></div>)}</div>)}
    </div>
    <div data-avatar-sizes className="flex flex-wrap items-end gap-5 p-5">{sizes.map(s => <div key={s} className="flex flex-col items-center gap-3"><BotAvatar look={{ shape: "mochi", color: "#60a5fa", accessory: "none" }} mood={mood} size={s} animate={animate}/><span>{s}px</span></div>)}</div>
    <div data-avatar-accessories className="flex flex-wrap gap-5 p-5">{AVATAR_ACCESSORIES.map(accessory => <div key={accessory} className="flex flex-col items-center gap-3"><BotAvatar look={{ shape: "bunny", color: "#c084fc", accessory }} mood={mood} size={72} animate={animate}/><span>{accessory}</span></div>)}</div>
    <details><summary>{"All shapes, moods and optical sizes" /* i18n-ignore: dev gallery */}</summary>{sizes.map(s => <div key={s} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 1200px" }}><p>{s}px</p>{AVATAR_SHAPES.map((shape, i) => <div key={shape} className="flex items-center gap-4 p-3"><span className="w-20">{shape}</span>{moods.map(m => <BotAvatar key={m} look={{ shape, color: AVATAR_PALETTE[i % AVATAR_PALETTE.length]!.hex, accessory: "none" }} mood={m} size={s} />)}</div>)}</div>)}</details>
  </div>;
};
