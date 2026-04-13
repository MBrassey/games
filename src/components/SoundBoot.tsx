"use client";

import { useEffect } from "react";
import { sound, bindDelegatedUiSounds } from "@/lib/sound";

// Audio engages on the very first user gesture anywhere on the page.
// Browsers (Chrome, Firefox, Safari) block all AudioContext output until
// a user has provided a gesture — pointerdown, click, keydown, touchstart.
// pointerover / mouseover do NOT count per the HTML5 autoplay spec, so
// hover SFX on the very first page load will only fire audibly after the
// user does *something* interactive once. We attach the delegated
// listeners immediately so there's zero latency after that first gesture.
export const MUTE_STORAGE_KEY = "brassey:audio-muted";

export default function SoundBoot() {
  useEffect(() => {
    const mutedByUser = (() => {
      try { return localStorage.getItem(MUTE_STORAGE_KEY) === "1"; }
      catch { return false; }
    })();

    const unbind = bindDelegatedUiSounds();

    if (mutedByUser) return () => { unbind(); };

    let off = false;
    const engage = async () => {
      if (off) return;
      off = true;
      window.removeEventListener("pointerdown", engage, true);
      window.removeEventListener("keydown", engage, true);
      window.removeEventListener("touchstart", engage, true);
      await sound.enable();
    };
    window.addEventListener("pointerdown", engage, true);
    window.addEventListener("keydown", engage, true);
    window.addEventListener("touchstart", engage, true);

    return () => {
      off = true;
      window.removeEventListener("pointerdown", engage, true);
      window.removeEventListener("keydown", engage, true);
      window.removeEventListener("touchstart", engage, true);
      unbind();
    };
  }, []);
  return null;
}
