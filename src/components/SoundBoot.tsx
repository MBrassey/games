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

    // Eager silent-start attempt. Audio defaults to ON — only mute
    // explicitly turns it off — so we ask the engine to resume on
    // mount. This works for:
    //   • Returning users whose browser has granted the site media-
    //     engagement autoplay permission (Chrome after repeat visits).
    //   • SPA navigations within a session that already unlocked
    //     audio on a previous page (the AudioContext survives across
    //     Next route changes).
    //
    // If the browser blocks the resume (first-ever load, no gesture
    // yet), `enable({ silent: true })` is a no-op that won't set
    // `enabled` to true — we'll retry on the first real gesture below,
    // at which point a normal (non-silent) enable plays the boot chime
    // and starts music. The `silent` flag prevents the startup chime
    // from firing on every SPA navigation.
    void sound.enable({ silent: true });

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

    // Tab-visibility restore: if the browser auto-suspended our context
    // while the tab was backgrounded, bring it back the moment the tab
    // becomes visible again rather than waiting for the user's next
    // click. No gesture needed here — we're just resuming an already-
    // unlocked context.
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
