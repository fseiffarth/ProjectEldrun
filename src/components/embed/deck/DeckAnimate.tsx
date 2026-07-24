/**
 * Animate mode — deliberately a *separate* mode from design, as the feature was
 * specified: the design canvas never touches animation, and this panel never
 * moves anything.
 *
 * Two orthogonal axes live here, and the distinction is worth keeping straight:
 *
 * **Builds** reveal objects *within* a slide. Each object gets a step (0 =
 * visible on entry) and an effect. `Stagger` assigns consecutive steps to the
 * selection in paint order, which is the one-click "reveal this list a line at a
 * time" the list-style model exists to make cheap.
 *
 * **Interstitials** are the headline: a GIF that plays *between* this slide and
 * the next, occupying its own stop in the presentation. A TeX-generated PDF
 * cannot carry animation at all, so without this the author has to leave the deck
 * and alt-tab to a video player mid-talk. It is not a transition effect and not
 * an object — it never composites onto a page.
 *
 * **Transitions** are the third, cosmetic axis: how one page replaces another.
 */

import { open } from "@tauri-apps/plugin-dialog";
import {
  type BuildEffect,
  type ObjectList,
  type Slide,
  type Transition,
  maxBuildStep,
  newInterstitialId,
  stagger,
  updateObjects,
} from "../../../lib/viewers/deck/model";

export interface DeckAnimateProps {
  slide: Slide;
  selection: ReadonlySet<string>;
  onObjectsChange: (objects: ObjectList) => void;
  onSlideChange: (patch: (s: Slide) => Slide) => void;
  /** Build step being previewed on the stage. */
  previewStep: number;
  onPreviewStep: (step: number) => void;
  /** Turns an absolute path into one relative to the deck, for storage. */
  toDeckRelative: (absolute: string) => string;
}

const EFFECTS: Array<{ id: BuildEffect; label: string }> = [
  { id: "none", label: "Appear" },
  { id: "fade", label: "Fade in" },
  { id: "rise", label: "Rise" },
  { id: "scale", label: "Scale" },
  { id: "wipe", label: "Wipe" },
  { id: "draw", label: "Draw" },
];

export function DeckAnimate({
  slide,
  selection,
  onObjectsChange,
  onSlideChange,
  previewStep,
  onPreviewStep,
  toDeckRelative,
}: DeckAnimateProps) {
  const ids = [...selection];
  const sel = slide.objects.filter((o) => selection.has(o.id));
  const steps = maxBuildStep(slide);
  const after = slide.after;

  const pickGif = async () => {
    const chosen = await open({
      multiple: false,
      filters: [{ name: "Animated GIF", extensions: ["gif"] }],
    });
    if (typeof chosen !== "string") return;
    onSlideChange((s) => ({
      ...s,
      after: {
        id: s.after?.id ?? newInterstitialId(),
        src: toDeckRelative(chosen),
        fit: s.after?.fit ?? "contain",
        background: s.after?.background ?? "#000000",
        advance: s.after?.advance ?? { on: "manual" },
        poster: s.after?.poster ?? 0,
      },
    }));
  };

  return (
    <div className="deck-inspector deck-animate">
      {/* --- build steps --- */}
      <div className="deck-inspector-head">Builds</div>

      {sel.length === 0 ? (
        <p className="deck-inspector-empty">
          Select objects to give them a build step. Step 0 is visible when the slide
          opens.
        </p>
      ) : (
        <>
          <div className="deck-field-row">
            <label className="deck-field deck-field-narrow">
              <span>Step</span>
              <input
                type="number"
                min={0}
                value={sel[0].build?.step ?? 0}
                onChange={(e) => {
                  const step = Math.max(0, Math.round(Number(e.target.value)));
                  if (!Number.isFinite(step)) return;
                  onObjectsChange(
                    updateObjects(slide.objects, ids, (o) => ({
                      ...o,
                      build: { step, effect: o.build?.effect ?? "fade" },
                    })),
                  );
                }}
              />
            </label>
            <label className="deck-field">
              <span>Effect</span>
              <select
                value={sel[0].build?.effect ?? "fade"}
                onChange={(e) =>
                  onObjectsChange(
                    updateObjects(slide.objects, ids, (o) => ({
                      ...o,
                      build: { step: o.build?.step ?? 0, effect: e.target.value as BuildEffect },
                    })),
                  )
                }
              >
                {EFFECTS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="deck-field-row">
            <button
              className="deck-inspector-btn"
              onClick={() => onObjectsChange(stagger(slide.objects, ids, 1))}
              title="Give each selected object its own step, in paint order"
            >
              Stagger
            </button>
            <button
              className="deck-inspector-btn"
              onClick={() =>
                onObjectsChange(
                  updateObjects(slide.objects, ids, (o) => ({ ...o, build: undefined })),
                )
              }
              title="Show these from the start"
            >
              Clear
            </button>
          </div>
        </>
      )}

      {/* --- preview --- */}
      <div className="deck-field">
        <span>
          Preview step {previewStep} of {steps}
        </span>
        <input
          type="range"
          min={0}
          max={Math.max(0, steps)}
          value={Math.min(previewStep, steps)}
          onChange={(e) => onPreviewStep(Number(e.target.value))}
        />
      </div>

      {/* --- transition --- */}
      <div className="deck-inspector-head">Transition</div>
      <label className="deck-field">
        <span>Leaving this slide</span>
        <select
          value={slide.transition}
          onChange={(e) =>
            onSlideChange((s) => ({ ...s, transition: e.target.value as Transition }))
          }
        >
          <option value="none">None</option>
          <option value="fade">Fade</option>
          <option value="push">Push</option>
          <option value="wipe">Wipe</option>
        </select>
      </label>

      {/* --- interstitial --- */}
      <div className="deck-inspector-head">Animation after this slide</div>
      <p className="deck-inspector-empty">
        A GIF that plays between this slide and the next, as its own step. A PDF
        cannot hold animation, so this is where it lives.
      </p>

      {!after ? (
        <button className="deck-inspector-btn" onClick={() => void pickGif()}>
          Add a GIF…
        </button>
      ) : (
        <>
          <div className="deck-animate-file" title={after.src}>
            {after.src.split("/").pop()}
          </div>
          <div className="deck-field-row">
            <label className="deck-field">
              <span>Fit</span>
              <select
                value={after.fit}
                onChange={(e) =>
                  onSlideChange((s) => ({
                    ...s,
                    after: s.after && { ...s.after, fit: e.target.value as "contain" | "cover" },
                  }))
                }
              >
                <option value="contain">Fit (letterbox)</option>
                <option value="cover">Fill (crop)</option>
              </select>
            </label>
            <label className="deck-field deck-field-color">
              <span>Back</span>
              <input
                type="color"
                value={after.background}
                onChange={(e) =>
                  onSlideChange((s) => ({
                    ...s,
                    after: s.after && { ...s.after, background: e.target.value },
                  }))
                }
              />
            </label>
          </div>
          <label className="deck-field">
            <span>Then</span>
            <select
              value={after.advance.on}
              onChange={(e) => {
                const on = e.target.value as "manual" | "end" | "end-after";
                onSlideChange((s) => ({
                  ...s,
                  after:
                    s.after &&
                    { ...s.after, advance: on === "end-after" ? { on, loops: 2 } : { on } },
                }));
              }}
            >
              <option value="manual">Loop until I advance</option>
              <option value="end">Play once, then continue</option>
              <option value="end-after">Play N times, then continue</option>
            </select>
          </label>
          {after.advance.on === "end-after" && (
            <label className="deck-field deck-field-narrow">
              <span>Times</span>
              <input
                type="number"
                min={1}
                value={after.advance.loops}
                onChange={(e) => {
                  const loops = Math.max(1, Math.round(Number(e.target.value)));
                  if (!Number.isFinite(loops)) return;
                  onSlideChange((s) => ({
                    ...s,
                    after: s.after && { ...s.after, advance: { on: "end-after", loops } },
                  }));
                }}
              />
            </label>
          )}
          <label className="deck-field deck-field-narrow">
            <span>Poster frame</span>
            <input
              type="number"
              min={0}
              value={after.poster}
              title="The frame the PDF export writes in place of the animation"
              onChange={(e) => {
                const poster = Math.max(0, Math.round(Number(e.target.value)));
                if (!Number.isFinite(poster)) return;
                onSlideChange((s) => ({ ...s, after: s.after && { ...s.after, poster } }));
              }}
            />
          </label>
          <button
            className="deck-inspector-btn"
            onClick={() => onSlideChange((s) => ({ ...s, after: undefined }))}
          >
            Remove animation
          </button>
        </>
      )}
    </div>
  );
}
