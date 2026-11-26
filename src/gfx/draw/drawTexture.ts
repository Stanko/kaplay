import { DEF_ANCHOR } from "../../constants/general";
import { Color } from "../../math/color";
import { Quad } from "../../math/math";
import type { Vec2 } from "../../math/Vec2";
import { type Anchor, BlendMode, type RenderProps } from "../../types";
import { anchorPt } from "../anchor";
import type { Texture } from "../gfx";
import { drawRaw } from "./drawRaw";
import {
    drawTexturedQuad,
    FULL_TEXTURE_REGION,
    type TextureRegion,
} from "./drawUVQuad";

/**
 * How the texture should look like.
 *
 * @group Draw
 * @subgroup Types
 */
export type DrawTextureOpt = RenderProps & {
    tex: Texture;
    width?: number;
    height?: number;
    tiled?: boolean;
    flipX?: boolean;
    flipY?: boolean;
    quad?: Quad;
    anchor?: Anchor | Vec2;
};

export function drawTexture(opt: DrawTextureOpt) {
    if (!opt.tex) {
        throw new Error("drawTexture() requires property \"tex\".");
    }

    drawTextureRegion(
        opt,
        opt.tex,
        opt.quad ?? FULL_TEXTURE_REGION,
        opt.width,
        opt.height,
    );
}

export function drawTextureRegion(
    opt: Omit<DrawTextureOpt, "tex" | "quad" | "width" | "height">,
    texture: Texture,
    region: TextureRegion,
    width?: number,
    height?: number,
) {
    const tileWidth = texture.width * region.w;
    const tileHeight = texture.height * region.h;
    width ??= tileWidth;
    height ??= tileHeight;

    if (opt.tiled) {
        const offset = anchorPt(opt.anchor ?? DEF_ANCHOR);
        const offsetX = (opt.pos?.x ?? 0) - (offset.x + 1) * 0.5 * width;
        const offsetY = (opt.pos?.y ?? 0) - (offset.y + 1) * 0.5 * height;

        // cSpell: ignore fcols frows
        const fcols = width / tileWidth;
        const frows = height / tileHeight;
        const cols = Math.floor(fcols);
        const rows = Math.floor(frows);
        const fracX = fcols - cols;
        const fracY = frows - rows;
        const n = (cols + fracX ? 1 : 0) * (rows + fracY ? 1 : 0);
        const indices = new Array<number>(n * 6);
        const attributes = {
            pos: new Array<number>(n * 4 * 2),
            uv: new Array<number>(n * 4 * 2),
            color: new Array<number>(n * 4 * 3),
            opacity: new Array<number>(n * 4),
        };
        let index = 0;

        const color = opt.color ?? Color.WHITE;
        const opacity = opt.opacity ?? 1;

        const addQuad = (
            x: number,
            y: number,
            w: number,
            h: number,
            q: TextureRegion,
        ) => {
            indices[index * 6 + 0] = index * 4 + 0;
            indices[index * 6 + 1] = index * 4 + 1;
            indices[index * 6 + 2] = index * 4 + 3;
            indices[index * 6 + 3] = index * 4 + 1;
            indices[index * 6 + 4] = index * 4 + 2;
            indices[index * 6 + 5] = index * 4 + 3;

            let s = index * 4;
            attributes.pos[s * 2] = x + offsetX;
            attributes.pos[s * 2 + 1] = y + offsetY;
            attributes.uv[s * 2] = q.x;
            attributes.uv[s * 2 + 1] = q.y;
            attributes.color[s * 3] = color.r;
            attributes.color[s * 3 + 1] = color.g;
            attributes.color[s * 3 + 2] = color.b;
            attributes.opacity[s] = opacity;
            s++;
            attributes.pos[s * 2] = x + w + offsetX;
            attributes.pos[s * 2 + 1] = y + offsetY;
            attributes.uv[s * 2] = q.x + q.w;
            attributes.uv[s * 2 + 1] = q.y;
            attributes.color[s * 3] = color.r;
            attributes.color[s * 3 + 1] = color.g;
            attributes.color[s * 3 + 2] = color.b;
            attributes.opacity[s] = opacity;
            s++;
            attributes.pos[s * 2] = x + w + offsetX;
            attributes.pos[s * 2 + 1] = y + h + offsetY;
            attributes.uv[s * 2] = q.x + q.w;
            attributes.uv[s * 2 + 1] = q.y + q.h;
            attributes.color[s * 3] = color.r;
            attributes.color[s * 3 + 1] = color.g;
            attributes.color[s * 3 + 2] = color.b;
            attributes.opacity[s] = opacity;
            s++;
            attributes.pos[s * 2] = x + offsetX;
            attributes.pos[s * 2 + 1] = y + h + offsetY;
            attributes.uv[s * 2] = q.x;
            attributes.uv[s * 2 + 1] = q.y + q.h;
            attributes.color[s * 3] = color.r;
            attributes.color[s * 3 + 1] = color.g;
            attributes.color[s * 3 + 2] = color.b;
            attributes.opacity[s] = opacity;
            index++;
        };

        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                addQuad(
                    i * tileWidth,
                    j * tileHeight,
                    tileWidth,
                    tileHeight,
                    region,
                );
            }

            if (fracX) {
                addQuad(
                    cols * tileWidth,
                    j * tileHeight,
                    tileWidth * fracX,
                    tileHeight,
                    new Quad(region.x, region.y, region.w * fracX, region.h),
                );
            }
        }

        if (fracY) {
            for (let i = 0; i < cols; i++) {
                addQuad(
                    i * tileWidth,
                    rows * tileHeight,
                    tileWidth,
                    tileHeight * fracY,
                    new Quad(region.x, region.y, region.w, region.h * fracY),
                );
            }

            if (fracX) {
                addQuad(
                    cols * tileWidth,
                    rows * tileHeight,
                    tileWidth * fracX,
                    tileHeight * fracY,
                    new Quad(
                        region.x,
                        region.y,
                        region.w * fracX,
                        region.h * fracY,
                    ),
                );
            }
        }

        drawRaw(
            attributes,
            indices,
            opt.fixed,
            texture,
            opt.shader,
            opt.uniform ?? undefined,
            opt.blend ?? BlendMode.Normal,
        );
    }
    else {
        drawTexturedQuad(opt, width, height, texture, region);
    }
}
