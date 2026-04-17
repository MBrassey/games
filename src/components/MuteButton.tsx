"use client";

import { useEffect, useState } from "react";
import { sound } from "@/lib/sound";
import { MUTE_STORAGE_KEY } from "./SoundBoot";

// The mute button controls ONLY the background music. Interface SFX
// (hover, click, confirm, deny, notify, etc.) always play regardless
// of mute state — the AudioContext stays running, only the music bus
// is silenced. This matches the user's expectation: "mute the
// soundtrack, not the whole console."
export default function MuteButton() {
  const [muted, setMuted] = useState<boolean>(false);

  useEffect(() => {
    try {
      setMuted(localStorage.getItem(MUTE_STORAGE_KEY) === "1");
    } catch { /* ignore */ }
  }, []);

  const toggle = async () => {
    if (muted) {
      // Unmute music. Also ensure the context is unlocked (this click
      // counts as a gesture). enable() is a no-op if already enabled.
      await sound.enable();
      sound.unmuteMusic();
      setMuted(false);
      try { localStorage.removeItem(MUTE_STORAGE_KEY); } catch {}
    } else {
      sound.muteMusic();
      setMuted(true);
      try { localStorage.setItem(MUTE_STORAGE_KEY, "1"); } catch {}
    }
  };

  return (
    <button
      onClick={toggle}
      className="btn"
      title={muted ? "music muted — click to resume" : "music on — click to mute"}
      aria-label={muted ? "unmute music" : "mute music"}
      aria-pressed={!muted}
    >
      <span className={muted ? "text-bone/50" : "text-abyss-cyan"}>
        {muted ? "◌" : "◉"}
      </span>
      <span className={`ml-1.5 ${muted ? "text-bone/50" : ""}`}>
        {muted ? "muted" : "music"}
      </span>
    </button>
  );
}
