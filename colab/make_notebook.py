"""Generates colab/paint_waterloo.ipynb. Edit the cells here, then run:  python3 colab/make_notebook.py"""
import json, os

cells = []
def md(s): cells.append({"cell_type": "markdown", "metadata": {}, "source": s.strip("\n")})
def code(s): cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [], "source": s.strip("\n")})

md("""
# Isometric Waterloo: AI painter

Turns an isometric render into a painted map (`map.png`), using a pipeline like isometric.nyc's, with free models only.
Two looks:
* **painted**: a light repaint of `photo.png` (Google 3D Tiles render) into a clean illustrated map, the Tiny Toronto look
* **photo pixel art** (the default): repaints `photo.png` as 90s game art, keeping the real buildings, the isometric.nyc look
* **pixel art**: the same style from `render.png` (OSM whitebox); no Google key needed, but building details are made up

How it works:

* **SDXL** + a **pixel-art LoRA** for the style
* **ControlNet (canny)**, so every building stays exactly where the render put it. That keeps hover and labels aligned.
* **Infill**: the map is painted in 1024×1024 windows that move 512 px at a time. Each new window is *inpainted* next to the
  already-painted area, so tiles join without seams.

**Before you start:** `Runtime → Change runtime type → T4 GPU` (free tier).

1. Put `photo.png` (or `render.png`) and `meta.json` (from `out/` in the project) in Google Drive at `MyDrive/isometric-waterloo/`.
   If they aren't there, the notebook asks you to upload them instead.
2. Run the cells in order. Use the **style test** cell to tune the prompt before the full run.
3. The full run saves progress to Drive after every window. If Colab disconnects, run everything again and it **resumes**.
4. Download `map.png` into the project's `out/` folder and refresh the viewer.
""")

code("""
# @title 1. Install
!pip -q install "diffusers>=0.30" transformers accelerate peft safetensors opencv-python-headless
# Colab ships an old torchao that new peft rejects when loading LoRAs; it isn't needed here.
!pip -q uninstall -y torchao
""")

code("""
# @title 2. Settings
STYLE = "photo pixel art (isometric.nyc look, real buildings, use photo.png)"  # @param ["photo pixel art (isometric.nyc look, real buildings, use photo.png)", "pixel art (from render.png, no Google key needed)", "painted (Tiny Toronto look, use photo.png)", "custom"]
INPUT = "render.png"  # @param ["render.png", "photo.png"]  (presets set this for you; only used by "custom")
PROMPT = "isometric pixel art of a university campus, 90s city builder game style, detailed buildings with windows and flat rooftops, lush round trees, grey roads, parking lots, crisp clean pixels, vibrant colors, high detail"  # @param {type:"string"}
NEGATIVE = "blurry, photo, photorealistic, 3d render, smooth gradients, text, watermark, signature, people, noise, jpeg artifacts, perspective distortion, fisheye"  # @param {type:"string"}
STEPS = 30  # @param {type:"integer"}
GUIDANCE = 6.5  # @param {type:"number"}
STRENGTH = 0.8  # @param {type:"number"}
CONTROL_SCALE = 0.55  # @param {type:"number"}
LORA_SCALE = 0.9  # @param {type:"number"}
OVERLAP = 32  # @param {type:"integer"}
SEED = 1234  # @param {type:"integer"}
PIXEL_SIZE = 2  # @param {type:"integer"}
PALETTE_COLORS = 96  # @param {type:"integer"}
USE_DRIVE = True  # @param {type:"boolean"}

# PROMPT / NEGATIVE: the style. Try "watercolor painting", "gouache illustration" etc. for a non-pixel look (then set LORA_SCALE = 0).
# STRENGTH: 1.0 ignores the render's colours; lower keeps them (green grass, blue water) and makes tiles more consistent.
# CONTROL_SCALE: how strictly building edges are followed. Raise it if buildings drift, lower it if the result looks like a traced render.
# PIXEL_SIZE / PALETTE_COLORS: post-processing for crisp pixel art (1 / 0 to disable).

PRESETS = {
    # Light repaint of the Google photo render: removes photogrammetry mush, keeps the real roofs/colours.
    "painted": dict(PROMPT="highly detailed digital painting of a city seen from above, miniature illustrated map, clean crisp building edges, "
                           "clear windows and rooftops, lush trees, soft painterly textures, warm sunlight, vibrant natural colors",
                    NEGATIVE="blurry, melted, warped buildings, smudged, noise, text, watermark, people, cartoon, pixel art, fisheye",
                    STRENGTH=0.35, CONTROL_SCALE=0.6, LORA_SCALE=0.0, GUIDANCE=6.0, PIXEL_SIZE=1, PALETTE_COLORS=0,
                    INPUT="photo.png"),
    "pixel art": dict(INPUT="render.png"),  # the values above; paints the OSM whitebox, no Google key needed
    # Pixel art over the Google photo render: real roofs, colours and materials, like isometric.nyc.
    # Lower STRENGTH keeps more of the real building; higher looks more like pixel art.
    # The pixel-art LoRA paints chunky ~8px blocks at full weight, which wipes out building detail. So here it is
    # only a light nudge; the crisp small pixels come from PIXEL_SIZE + PALETTE_COLORS in post-processing.
    "photo pixel art": dict(INPUT="photo.png", STRENGTH=0.4, CONTROL_SCALE=0.75, LORA_SCALE=0.3, GUIDANCE=5.5,
                            PIXEL_SIZE=2, PALETTE_COLORS=128,
                            PROMPT="detailed isometric pixel art of a university campus, 90s city builder game, small crisp pixels, "
                                   "faithful real colors, clear building shapes with windows and rooftops, round trees, clean roads",
                            NEGATIVE="large pixels, blocky, low resolution, mosaic, blurry, smudged, melted buildings, purple tint, "
                                     "text, watermark, people, fisheye"),
}
for key, values in PRESETS.items():
    if STYLE.startswith(key):
        globals().update(values)
print(f"style: {STYLE} | input: {INPUT} | strength {STRENGTH}, control {CONTROL_SCALE}, lora {LORA_SCALE}")
""")

code("""
# @title 3. Load inputs
import os, json, time, numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

WORK = "/content/work"
if USE_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    WORK = "/content/drive/MyDrive/isometric-waterloo"
os.makedirs(WORK, exist_ok=True)

for name in [INPUT, "meta.json"]:
    if not os.path.exists(f"{WORK}/{name}"):
        from google.colab import files
        print(f"Upload {name}:")
        up = files.upload()
        for k, v in up.items():
            open(f"{WORK}/{name if k.startswith(name.split('.')[0]) else k}", "wb").write(v)

meta = json.load(open(f"{WORK}/meta.json"))
render = np.array(Image.open(f"{WORK}/{INPUT}").convert("RGB"))
H, W = render.shape[:2]
bg = np.array([int(meta["background"][i:i + 2], 16) for i in (1, 3, 5)])
is_bg = np.all(np.abs(render.astype(int) - bg) <= 3, axis=-1)
T = 512
windows = [(x, y) for y in range(0, H - T, T) for x in range(0, W - T, T)]
print(f"render {W}x{H}, {len(windows)} windows of 1024px, {100 * (1 - is_bg.mean()):.0f}% of pixels are map")
""")

code("""
# @title 4. Load models (SDXL + canny ControlNet + pixel-art LoRA)
import torch
from diffusers import StableDiffusionXLControlNetInpaintPipeline, ControlNetModel, AutoencoderKL

controlnet = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16)
pipe = StableDiffusionXLControlNetInpaintPipeline.from_pretrained(
    "stabilityai/stable-diffusion-xl-base-1.0", controlnet=controlnet, vae=vae,
    torch_dtype=torch.float16, variant="fp16", use_safetensors=True)
pipe.load_lora_weights("nerijs/pixel-art-xl", weight_name="pixel-art-xl.safetensors", adapter_name="pixel")
pipe.set_adapters(["pixel"], adapter_weights=[LORA_SCALE])  # LORA_SCALE = 0 turns the pixel-art style off
try:
    pipe.to("cuda")
except torch.cuda.OutOfMemoryError:
    torch.cuda.empty_cache()
    pipe.enable_model_cpu_offload()
pipe.set_progress_bar_config(disable=True)
print("models ready")
""")

code("""
# @title 5. Painting helpers
import cv2

def canny(img):
    e = cv2.Canny(cv2.cvtColor(img, cv2.COLOR_RGB2GRAY), 60, 160)
    return Image.fromarray(np.stack([e] * 3, -1))

def finish(img):
    \"\"\"Post-processing for crisp pixel art: snap to a PIXEL_SIZE grid and a PALETTE_COLORS palette.\"\"\"
    img = Image.fromarray(img) if isinstance(img, np.ndarray) else img
    w, h = img.size
    if PIXEL_SIZE > 1:
        img = img.resize((w // PIXEL_SIZE, h // PIXEL_SIZE), Image.BOX).resize((w, h), Image.NEAREST)
    if PALETTE_COLORS > 0:
        img = img.quantize(PALETTE_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    return np.array(img)

def paint_window(canvas, painted, x, y, seed):
    \"\"\"Inpaints the unpainted part of the 1024px window at (x, y). Returns True if anything was painted.\"\"\"
    S = 2 * T
    win_render = render[y:y + S, x:x + S]
    win_done = painted[y:y + S, x:x + S]
    todo = ~win_done & ~is_bg[y:y + S, x:x + S]
    if not todo.any():
        painted[y:y + S, x:x + S] |= ~win_done
        return False
    init = np.where(win_done[..., None], canvas[y:y + S, x:x + S], win_render)
    need = (~win_done).astype(np.uint8) * 255
    # let the model also repaint a thin band of finished pixels so the join blends
    mask = cv2.dilate(need, np.ones((OVERLAP, OVERLAP), np.uint8)) if win_done.any() else need
    out = pipe(
        prompt=PROMPT, negative_prompt=NEGATIVE,
        image=Image.fromarray(init), mask_image=Image.fromarray(mask), control_image=canny(win_render),
        width=S, height=S, strength=STRENGTH, num_inference_steps=STEPS, guidance_scale=GUIDANCE,
        controlnet_conditioning_scale=CONTROL_SCALE, generator=torch.Generator("cuda").manual_seed(seed),
    ).images[0]
    out = np.array(out.convert("RGB").resize((S, S)))
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255, (0, 0), OVERLAP / 3)
    alpha = np.maximum(alpha, need / 255)[..., None]
    canvas[y:y + S, x:x + S] = (alpha * out + (1 - alpha) * init).astype(np.uint8)
    painted[y:y + S, x:x + S] = True
    return True
""")

code("""
# @title 6. Style test: paint the busiest window and compare
from IPython.display import display
busiest = max(windows, key=lambda w: cv2.Canny(cv2.cvtColor(render[w[1]:w[1] + 2 * T, w[0]:w[0] + 2 * T], cv2.COLOR_RGB2GRAY), 60, 160).mean())
tc, tp = render.copy(), np.zeros((H, W), bool)
t0 = time.time()
paint_window(tc, tp, *busiest, SEED)
print(f"window {busiest} painted in {time.time() - t0:.0f}s. Estimated full run: ~{(time.time() - t0) * len(windows) / 60:.0f} min")
x, y = busiest
before, after = render[y:y + 2 * T, x:x + 2 * T], finish(tc[y:y + 2 * T, x:x + 2 * T])  # same post-processing as the final map
print("left: input | right: final look")
display(Image.fromarray(np.concatenate([before, after], 1)).resize((1400, 700)))
print("1:1 close-up (how it looks fully zoomed in):")
display(Image.fromarray(np.concatenate([before[256:640, 256:640], after[256:640, 256:640]], 1)))
""")

code("""
# @title 7. Full run (resumable)
ckpt_img, ckpt_mask = f"{WORK}/progress.png", f"{WORK}/progress_mask.npy"
if os.path.exists(ckpt_img) and os.path.exists(ckpt_mask):
    canvas = np.array(Image.open(ckpt_img).convert("RGB")); painted = np.load(ckpt_mask)
    print(f"resuming: {painted.mean() * 100:.0f}% painted")
else:
    canvas, painted = render.copy(), np.zeros((H, W), bool)

t0, n = time.time(), 0
for i, (x, y) in enumerate(windows):
    if painted[y:y + 2 * T, x:x + 2 * T].all():
        continue
    if paint_window(canvas, painted, x, y, SEED + i):
        n += 1
        Image.fromarray(canvas).save(ckpt_img); np.save(ckpt_mask, painted)
        print(f"[{i + 1}/{len(windows)}] window ({x},{y}) done, {(time.time() - t0) / n:.0f}s/window")
painted[:] = True
Image.fromarray(canvas).save(ckpt_img); np.save(ckpt_mask, painted)
print("all windows painted")
""")

code("""
# @title 8. Finish: pixelate, restore background, save map.png
final = finish(canvas)
final[is_bg] = bg  # keep the clean diorama edge
Image.fromarray(final).save(f"{WORK}/map.png", optimize=True)
display(Image.fromarray(final).resize((W // 4, H // 4)))
print(f"saved {WORK}/map.png. Download it into the project's out/ folder.")
if not USE_DRIVE:
    from google.colab import files
    files.download(f"{WORK}/map.png")
""")

nb = {
    "nbformat": 4, "nbformat_minor": 0,
    "metadata": {"accelerator": "GPU", "colab": {"provenance": [], "gpuType": "T4"},
                 "kernelspec": {"name": "python3", "display_name": "Python 3"}, "language_info": {"name": "python"}},
    "cells": cells,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paint_waterloo.ipynb")
json.dump(nb, open(path, "w"), indent=1)
print("wrote", path)
