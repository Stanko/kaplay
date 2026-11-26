import { Asset } from "../../assets/asset";
import { resolveShader, type Uniform } from "../../assets/shader";
import { _k } from "../../shared";
import { type Attributes, BlendMode, type RenderProps } from "../../types";
import type { Texture } from "../gfx";
import { height, width } from "../stack";

// The renderer copies the populated prefix before returning.
const packedVertices: number[] = [];

export function drawRaw(
    attributes: Attributes,
    indices: number[],
    fixed: boolean = false,
    tex?: Texture,
    shaderSrc?: RenderProps["shader"],
    uniform?: Uniform,
    blend?: BlendMode,
) {
    const parsedTex = tex ?? _k.gfx.whitePixel.tex;
    const parsedShader = shaderSrc ?? _k.gfx.defShader;
    const shader = resolveShader(parsedShader);

    if (!shader || shader instanceof Asset) {
        return;
    }

    const { transform, scratchPt: point } = _k.gfx;
    const vertexCount = attributes.pos.length / 2;
    let writeIndex = 0;
    for (let i = 0; i < vertexCount; i++) {
        point.x = attributes.pos[i * 2];
        point.y = attributes.pos[i * 2 + 1];
        transform.transformPointV(point, point);

        packedVertices[writeIndex++] = point.x;
        packedVertices[writeIndex++] = point.y;
        packedVertices[writeIndex++] = attributes.uv[i * 2];
        packedVertices[writeIndex++] = attributes.uv[i * 2 + 1];
        packedVertices[writeIndex++] = attributes.color[i * 3] / 255;
        packedVertices[writeIndex++] = attributes.color[i * 3 + 1] / 255;
        packedVertices[writeIndex++] = attributes.color[i * 3 + 2] / 255;
        packedVertices[writeIndex++] = attributes.opacity[i];
    }

    _k.gfx.renderer.push(
        _k.gfx.ggl.gl.TRIANGLES,
        packedVertices,
        indices,
        shader,
        parsedTex,
        uniform,
        blend ?? BlendMode.Normal,
        width(),
        height(),
        _k.gfx.fixed || fixed,
        writeIndex,
    );
}
