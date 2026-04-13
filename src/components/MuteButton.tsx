"use client";

import { useEffect, useState } from "react";
import { sound } from "@/lib/sound";
import { MUTE_STORAGE_KEY } from "./SoundBoot";

// Audio defaults to ON. The button is optimistic — it reads "audio on"
// until the user explicitly mutes, and that choice persists across
// sessions via localStorage. Clicking mutes everything (music + SFX).
// Clicking again resumes.
export default function MuteButton() {
  // Start optimistic: on load we ASSUME audio will be on. We reconcile
  // with the engine state + stored preference once we're on the client.
  const [muted, setMuted] = useState<boolean>(false);

  useEffect(() => {
    try {
      setMuted(localStorage.getItem(MUTE_STORAGE_KEY) === "1");
    } catch { /* ignore */ }
  }, []);

  const toggle = async () => {
    if (muted) {
      // Unmute: this click IS the user gesture that unlocks the context.
      await sound.enable();
      setMuted(false);
      try { localStorage.removeItem(MUTE_STORAGE_KEY); } catch {}
    } else {
      sound.disable();
      setMuted(true);
      try { localStorage.setItem(MUTE_STORAGE_KEY, "1"); } catch {}
    }
  };

  return (
    <button
      onClick={toggle}
      className="btn"
      title={muted ? "muted — click to resume" : "audio on — click to mute"}
      aria-label={muted ? "unmute" : "mute audio"}
      aria-pressed={!muted}
    >
      <span className={muted ? "text-bone/50" : "text-abyss-cyan"}>
        {muted ? "◌" : "◉"}
      </span>
      <span className={`ml-1.5 ${muted ? "text-bone/50" : ""}`}>
        {muted ? "muted" : "audio"}
      </span>
    </button>
  );
}
