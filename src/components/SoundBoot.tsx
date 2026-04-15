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

    // Keep the engage listeners attached for the component's lifetime
    // instead of removing them after the first gesture. Two reasons:
    //
    //   1. In some browsers the very first `resume()` attempt can fail
    //      silently (returned promise rejects or the context stays
    //      "suspended" after a spurious autoplay-policy check). The next
    //      gesture lets us retry.
    //
    //   2. AudioContexts get auto-suspended when a tab backgrounds for
    //      long periods. Subsequent gestures need to call resume() again
    //      — sfx methods also call resumeIfNeeded() internally, but
    //      asking enable() to do it here is belt-and-suspenders.
    //
    // The `engage` body is fast when the engine is already enabled —
    // `sound.enable()` is a no-op in that state.
    const engage = async () => { try { await sound.enable(); } catch {} };
    window.addEventListener("pointerdown", engage, true);
    window.addEventListener("keydown", engage, true);
    window.addEventListener("touchstart", engage, true);

    return () => {
      window.removeEventListener("pointerdown", engage, true);
      window.removeEventListener("keydown", engage, true);
      window.removeEventListener("touchstart", engage, true);
      unbind();
    };
  }, []);
  return null;
}
