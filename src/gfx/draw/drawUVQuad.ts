import { DEF_ANCHOR } from "../../constants/general";
import { Color } from "../../math/color";
import type { Quad } from "../../math/math";
import type { Vec2 } from "../../math/Vec2";
import { type Anchor, BlendMode, type RenderProps } from "../../types";
import { anchorPt } from "../anchor";
import type { Texture } from "../gfx";
import {
    multRotate,
    multScaleV,
    multSkewV,
    multTranslate,
    multTranslateV,
    popTransform,
    pushTransform,
} from "../stack";
import { drawRaw } from "./drawRaw";

/**
 * How the UV Quad should look like.
 *
 * @group Draw
 * @subgroup Types
 */
export type DrawUVQuadOpt = RenderProps & {
    /**
     * Width of the UV quad.
     */
    width: number;
    /**
     * Height of the UV quad.
     */
    height: number;
    /**
     * If flip the texture horizontally.
     */
    flipX?: boolean;
    /**
     * If flip the texture vertically.
     */
    flipY?: boolean;
    /**
     * The texture to sample for this quad.
     */
    tex?: Texture;
    /**
     * The texture sampling area.
     */
    quad?: Quad;
    /**
     * The anchor point, or the pivot point. Default to "topleft".
     */
    anchor?: Anchor | Vec2;
};

export type TextureRegion = Pick<Quad, "x" | "y" | "w" | "h">;

export const FULL_TEXTURE_REGION: Readonly<TextureRegion> = Object.freeze({
    x: 0,
    y: 0,
    w: 1,
    h: 1,
});

const quadAttributes = {
    pos: [0, 0, 0, 0, 0, 0, 0, 0],
    uv: [0, 0, 0, 0, 0, 0, 0, 0],
    color: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    opacity: [0, 0, 0, 0],
};
const QUAD_INDICES = [0, 1, 3, 1, 2, 3];

export function drawUVQuad(opt: DrawUVQuadOpt) {
    const { width, height, tex, quad } = opt;
    if (width === undefined || height === undefined) {
        throw new Error(
            "drawUVQuad() requires property \"width\" and \"height\".",
        );
    }
    drawTexturedQuad(opt, width, height, tex, quad ?? FULL_TEXTURE_REGION);
}

export function drawTexturedQuad(
    opt: Omit<DrawUVQuadOpt, "width" | "height" | "tex" | "quad">,
    width: number,
    height: number,
    texture: Texture | undefined,
    region: TextureRegion,
) {
    if (width <= 0 || height <= 0) {
        return;
    }

    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const anchor = anchorPt(opt.anchor || DEF_ANCHOR);
    const color = opt.color || Color.WHITE;
    const opacity = opt.opacity ?? 1;

    pushTransform();
    multTranslateV(opt.pos);
    multRotate(opt.angle);
    multScaleV(opt.scale ?? undefined);
    multSkewV(opt.skew);
    multTranslate(-anchor.x * halfWidth, -anchor.y * halfHeight);

    // Corners run from bottom left to top left, top right, and bottom right.
    const { pos, uv, color: colors, opacity: opacities } = quadAttributes;
    pos[0] = pos[2] = -halfWidth;
    pos[4] = pos[6] = halfWidth;
    pos[1] = pos[7] = halfHeight;
    pos[3] = pos[5] = -halfHeight;

    const left = opt.flipX ? region.x + region.w : region.x;
    const right = opt.flipX ? region.x : region.x + region.w;
    const top = opt.flipY ? region.y + region.h : region.y;
    const bottom = opt.flipY ? region.y : region.y + region.h;
    uv[0] = uv[2] = left;
    uv[4] = uv[6] = right;
    uv[1] = uv[7] = bottom;
    uv[3] = uv[5] = top;

    for (let i = 0; i < colors.length; i += 3) {
        colors[i] = color.r;
        colors[i + 1] = color.g;
        colors[i + 2] = color.b;
    }
    opacities.fill(opacity);

    drawRaw(
        quadAttributes,
        QUAD_INDICES,
        opt.fixed,
        texture,
        opt.shader,
        opt.uniform ?? undefined,
        opt.blend ?? BlendMode.Normal,
    );

    popTransform();
}
