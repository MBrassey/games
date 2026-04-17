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
//
// IMPORTANT: the mute button controls only the MUSIC bus, not the
// interface SFX. When the user has muted via localStorage, we still
// unlock the AudioContext and attach gesture listeners so hover/click/
// confirm/deny sounds always work. Only the procedural soundtrack
// stops.
export const MUTE_STORAGE_KEY = "brassey:audio-muted";

export default function SoundBoot() {
  useEffect(() => {
    const mutedByUser = (() => {
      try { return localStorage.getItem(MUTE_STORAGE_KEY) === "1"; }
      catch { return false; }
    })();

    const unbind = bindDelegatedUiSounds();

    // Pre-set the mute flag BEFORE enable() runs. enable() checks
    // musicMuted and skips startMusic() if true — but still unlocks
    // the context and sets enabled=true so SFX work.
    if (mutedByUser) sound.setMusicMuted(true);

    // Eager silent-start attempt. Works immediately on SPA navigations
    // (AudioContext survives across Next route changes) and on returning
    // visitors whose browser has granted autoplay permission.
    void sound.enable({ silent: true });

    // Self-healing gesture listeners — stay attached for the component's
    // lifetime. First gesture unlocks the context; subsequent gestures
    // re-resume if the browser auto-suspended it after a background dip.
    const engage = async () => { try { await sound.enable(); } catch {} };
    window.addEventListener("pointerdown", engage, true);
    window.addEventListener("keydown", engage, true);
    window.addEventListener("touchstart", engage, true);

    // Tab-visibility restore: resume the context the moment the tab
    // returns from background, without waiting for a user click.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void sound.enable({ silent: true });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.removeEventListener("pointerdown", engage, true);
      window.removeEventListener("keydown", engage, true);
      window.removeEventListener("touchstart", engage, true);
      document.removeEventListener("visibilitychange", onVisibility);
      unbind();
    };
  }, []);
  return null;
}
