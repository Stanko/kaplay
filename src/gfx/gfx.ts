import type { Shader, Uniform } from "../assets/shader";
import { IDENTITY_MATRIX } from "../constants/math";
import { getCamTransform } from "../game/camera";
import {
    BlendMode,
    type ImageSource,
    type KAPLAYOpt,
    type TextureOpt,
} from "../types";
import { deepEq } from "../utils/deepEq";
import type { Picture } from "./draw/drawPicture";

export type GfxCtx = ReturnType<typeof initGfx>;

/**
 * @group Rendering
 * @subgroup Canvas
 */
export class Texture {
    ctx: GfxCtx;
    src: null | ImageSource = null;
    glTex: WebGLTexture;
    width: number;
    height: number;

    constructor(ctx: GfxCtx, w: number, h: number, opt: TextureOpt = {}) {
        this.ctx = ctx;

        const gl = ctx.gl;
        const glText = ctx.gl.createTexture();

        if (!glText) {
            throw new Error("[rendering] Failed to create texture");
        }

        this.glTex = glText;
        ctx.onDestroy(() => this.free());

        this.width = w;
        this.height = h;

        const filter = {
            "linear": gl.LINEAR,
            "nearest": gl.NEAREST,
        }[opt.filter ?? ctx.opts.texFilter ?? "nearest"];

        const wrap = {
            "repeat": gl.REPEAT,
            "clampToEdge": gl.CLAMP_TO_EDGE,
        }[opt.wrap ?? "clampToEdge"];

        this.bind();

        if (w && h) {
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                w,
                h,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                null,
            );
        }

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        this.unbind();
    }

    static fromImage(
        ctx: GfxCtx,
        img: ImageSource,
        opt: TextureOpt = {},
    ): Texture {
        const tex = new Texture(ctx, img.width, img.height, opt);
        tex.update(img);
        tex.src = img;
        return tex;
    }

    update(img: ImageSource, x = 0, y = 0) {
        const gl = this.ctx.gl;
        this.bind();
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            x,
            y,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            img,
        );
        this.unbind();
    }

    bind() {
        this.ctx.pushTexture2D(this.glTex);
    }

    unbind() {
        this.ctx.popTexture2D();
    }

    /** Frees up texture memory. Call this once the texture is no longer being used to avoid memory leaks. */
    free() {
        this.ctx.gl.deleteTexture(this.glTex);
    }
}

/**
 * @group Rendering
 * @subgroup Shaders
 */
export type VertexFormat = {
    name: string;
    size: number;
}[];

const MAX_INDEXED_VERTICES = 65_536;

/**
 * @group Rendering
 * @subgroup Canvas
 */
export class BatchRenderer {
    ctx: GfxCtx;

    glVBuf: WebGLBuffer;
    glIBuf: WebGLBuffer;
    private vertexQueue: Float32Array;
    private indexQueue: Uint16Array;
    private queuedVertexFloats = 0;
    private queuedIndices = 0;
    stride: number;

    vertexFormat: VertexFormat;
    numDraws: number = 0;

    curPrimitive: GLenum | null = null;
    curTex: Texture | null = null;
    curShader: Shader | null = null;
    curUniform: Uniform | null = null;
    curBlend: BlendMode = BlendMode.Normal;
    curFixed: boolean | undefined = undefined;

    picture: Picture | null = null;

    constructor(
        ctx: GfxCtx,
        format: VertexFormat,
        vertexFloatCapacity: number,
        indexCapacity: number,
    ) {
        const gl = ctx.gl;

        this.vertexFormat = format;
        this.ctx = ctx;
        this.stride = format.reduce((sum, f) => sum + f.size, 0);

        const glVBuf = gl.createBuffer();
        const glIBuf = gl.createBuffer();

        if (!glVBuf || !glIBuf) {
            throw new Error("Failed to create batch buffers");
        }

        this.glVBuf = glVBuf;
        this.glIBuf = glIBuf;
        this.vertexQueue = this.allocateVertexQueue(vertexFloatCapacity);
        this.indexQueue = this.allocateIndexQueue(indexCapacity);
    }

    push(
        primitive: GLenum,
        vertices: number[],
        indices: number[],
        shader: Shader,
        tex: Texture | null = null,
        uniform: Uniform | null = null,
        blend: BlendMode,
        width: number,
        height: number,
        fixed: boolean,
        vertexFloatCount = vertices.length,
    ) {
        const indexCount = indices.length;
        // If we have a picture, redirect data to the picture instead
        if (this.picture) {
            const index = this.picture.indices.length;
            const indexOffset = this.picture.vertices.length / this.stride;
            for (let i = 0; i < vertexFloatCount; i++) {
                this.picture.vertices.push(vertices[i]);
            }
            for (let i = 0; i < indexCount; i++) {
                this.picture.indices.push(indices[i] + indexOffset);
            }
            const material = {
                tex: tex || undefined,
                shader,
                uniform: uniform || undefined,
                blend,
            };
            if (this.picture.commands.length) {
                const lastCommand =
                    this.picture.commands[this.picture.commands.length - 1];
                const lastMaterial = lastCommand.material;
                if (
                    lastMaterial.tex == material.tex
                    && lastMaterial.shader == material.shader
                    && lastMaterial.uniform == material.uniform
                    && lastMaterial.blend == material.blend
                ) {
                    lastCommand.count += indexCount;
                    return;
                }
            }
            const command = {
                material,
                index,
                count: indexCount,
            };
            this.picture.commands.push(command);
            return;
        }

        if (vertexFloatCount === 0 || indexCount === 0) return;

        const maxIndexedVertexFloats = MAX_INDEXED_VERTICES * this.stride;
        // An oversized draw may still reference only the first 65,536 vertices.
        if (
            vertexFloatCount > maxIndexedVertexFloats
            && indices.some(index => index >= MAX_INDEXED_VERTICES)
        ) {
            throw new RangeError("Draw exceeds the 16-bit vertex index range");
        }

        // Flush on a state change, a full queue, or before indices could wrap.
        if (
            primitive !== this.curPrimitive
            || tex !== this.curTex
            || shader !== this.curShader
            || ((this.curUniform != uniform)
                && !deepEq(this.curUniform, uniform))
            || blend !== this.curBlend
            || fixed !== this.curFixed
            || this.queuedVertexFloats + vertexFloatCount
                > this.vertexQueue.length
            || this.queuedVertexFloats + vertexFloatCount
                > maxIndexedVertexFloats
            || this.queuedIndices + indexCount > this.indexQueue.length
        ) {
            this.flush(width, height);
            this.setBlend(blend);
        }
        if (vertexFloatCount > this.vertexQueue.length) {
            this.vertexQueue = this.allocateVertexQueue(vertexFloatCount);
        }
        if (indexCount > this.indexQueue.length) {
            this.indexQueue = this.allocateIndexQueue(indexCount);
        }

        const vertexStart = this.queuedVertexFloats;
        const indexStart = this.queuedIndices;
        const firstVertex = vertexStart / this.stride;
        for (let i = 0; i < vertexFloatCount; i++) {
            this.vertexQueue[vertexStart + i] = vertices[i];
        }
        for (let i = 0; i < indexCount; i++) {
            this.indexQueue[indexStart + i] = indices[i] + firstVertex;
        }
        this.queuedVertexFloats = vertexStart + vertexFloatCount;
        this.queuedIndices = indexStart + indexCount;
        this.curPrimitive = primitive;
        this.curShader = shader;
        this.curTex = tex;
        this.curUniform = uniform;
        this.curFixed = fixed;
    }

    flush(width: number, height: number) {
        if (
            this.curPrimitive === null
            || !this.curShader
            || this.queuedIndices === 0
        ) {
            return;
        }

        const gl = this.ctx.gl;

        // Bind vertex data
        this.ctx.pushArrayBuffer(this.glVBuf);
        gl.bufferSubData(
            gl.ARRAY_BUFFER,
            0,
            this.vertexQueue.subarray(0, this.queuedVertexFloats),
        );

        // Bind index data
        this.ctx.pushElementArrayBuffer(this.glIBuf);
        gl.bufferSubData(
            gl.ELEMENT_ARRAY_BUFFER,
            0,
            this.indexQueue.subarray(0, this.queuedIndices),
        );

        // Set vertex format
        this.ctx.setVertexFormat(this.vertexFormat);

        // Bind Shader
        this.curShader.bind();

        // Send user uniforms
        if (this.curUniform) {
            this.curShader.send(this.curUniform);
        }

        // Send system uniforms
        this.curShader.send({
            width,
            height,
            camera: this.curFixed ? IDENTITY_MATRIX : getCamTransform(),
            transform: IDENTITY_MATRIX,
        });

        // Bind texture
        this.curTex?.bind();

        // Draw vertex buffer using active indices
        gl.drawElements(
            this.curPrimitive,
            this.queuedIndices,
            gl.UNSIGNED_SHORT,
            0,
        );

        // Unbind texture and shader
        this.curTex?.unbind();
        this.curShader.unbind();

        // Unbind buffers
        this.ctx.popArrayBuffer();
        this.ctx.popElementArrayBuffer();

        // Reset local buffers
        this.queuedVertexFloats = 0;
        this.queuedIndices = 0;

        // Increase draw
        this.numDraws++;
    }

    private allocateVertexQueue(capacity: number) {
        const { gl } = this.ctx;
        const queue = new Float32Array(capacity);
        this.ctx.pushArrayBuffer(this.glVBuf);
        gl.bufferData(gl.ARRAY_BUFFER, queue.byteLength, gl.DYNAMIC_DRAW);
        this.ctx.popArrayBuffer();
        return queue;
    }

    private allocateIndexQueue(capacity: number) {
        const { gl } = this.ctx;
        const queue = new Uint16Array(capacity);
        this.ctx.pushElementArrayBuffer(this.glIBuf);
        gl.bufferData(
            gl.ELEMENT_ARRAY_BUFFER,
            queue.byteLength,
            gl.DYNAMIC_DRAW,
        );
        this.ctx.popElementArrayBuffer();
        return queue;
    }

    free() {
        const gl = this.ctx.gl;
        gl.deleteBuffer(this.glVBuf);
        gl.deleteBuffer(this.glIBuf);
    }

    setBlend(blend: BlendMode) {
        if (blend !== this.curBlend) {
            const gl = this.ctx.gl;
            this.curBlend = blend;
            switch (this.curBlend) {
                case BlendMode.Normal:
                    gl.blendFuncSeparate(
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                    );
                    break;
                case BlendMode.Add:
                    gl.blendFuncSeparate(
                        gl.ONE,
                        gl.ONE,
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                    );
                    break;
                case BlendMode.Multiply:
                    gl.blendFuncSeparate(
                        gl.DST_COLOR,
                        gl.ZERO,
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                    );
                    break;
                case BlendMode.Screen:
                    gl.blendFuncSeparate(
                        gl.ONE_MINUS_DST_COLOR,
                        gl.ONE,
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                    );
                    break;
                case BlendMode.Overlay:
                    gl.blendFuncSeparate(
                        gl.DST_COLOR,
                        gl.ONE_MINUS_SRC_ALPHA,
                        gl.ONE,
                        gl.ONE_MINUS_SRC_ALPHA,
                    );
            }
        }
    }
}

/**
 * @group Rendering
 * @subgroup Shaders
 */
export class Mesh {
    ctx: GfxCtx;
    glVBuf: WebGLBuffer;
    glIBuf: WebGLBuffer;
    vertexFormat: VertexFormat;
    count: number;

    constructor(
        ctx: GfxCtx,
        format: VertexFormat,
        vertices: number[],
        indices: number[],
    ) {
        const gl = ctx.gl;
        this.vertexFormat = format;
        this.ctx = ctx;
        const glVBuf = gl.createBuffer();

        if (!glVBuf) throw new Error("Failed to create vertex buffer");

        this.glVBuf = glVBuf;

        ctx.pushArrayBuffer(this.glVBuf);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            new Float32Array(vertices),
            gl.STATIC_DRAW,
        );
        ctx.popArrayBuffer();

        this.glIBuf = gl.createBuffer()!;
        ctx.pushElementArrayBuffer(this.glIBuf);
        gl.bufferData(
            gl.ELEMENT_ARRAY_BUFFER,
            new Uint16Array(indices),
            gl.STATIC_DRAW,
        );
        ctx.popElementArrayBuffer();

        this.count = indices.length;
    }

    draw(primitive?: GLenum, index?: GLuint, count?: GLuint): void {
        const gl = this.ctx.gl;
        this.ctx.pushArrayBuffer(this.glVBuf);
        this.ctx.pushElementArrayBuffer(this.glIBuf);
        this.ctx.setVertexFormat(this.vertexFormat);
        gl.drawElements(
            primitive ?? gl.TRIANGLES,
            index ?? this.count,
            gl.UNSIGNED_SHORT,
            count ?? 0,
        );
        this.ctx.popArrayBuffer();
        this.ctx.popElementArrayBuffer();
    }

    free() {
        const gl = this.ctx.gl;
        gl.deleteBuffer(this.glVBuf);
        gl.deleteBuffer(this.glIBuf);
    }
}

function genStack<T>(setFunc: (item: T | null) => void) {
    const stack: T[] = [];
    // TODO: don't do anything if pushed item is the same as the one on top?
    const push = (item: T) => {
        stack.push(item);
        setFunc(item);
    };
    const pop = () => {
        stack.pop();
        setFunc(cur() ?? null);
    };
    const cur = () => stack[stack.length - 1];
    return [push, pop, cur] as const;
}

export function initGfx(gl: WebGLRenderingContext, opts: KAPLAYOpt = {}) {
    const gc: Array<() => void> = [];

    function onDestroy(action: () => unknown) {
        gc.push(action);
    }

    function destroy() {
        gc.forEach((action) => action());
        const extension = gl.getExtension("WEBGL_lose_context");
        if (extension) extension.loseContext();
    }

    let curVertexFormat: object | null = null;

    function setVertexFormat(fmt: VertexFormat) {
        if (deepEq(fmt, curVertexFormat)) return;
        curVertexFormat = fmt;
        const stride = fmt.reduce((sum, f) => sum + f.size, 0);
        fmt.reduce((offset, f, i) => {
            gl.enableVertexAttribArray(i);
            gl.vertexAttribPointer(
                i,
                f.size,
                gl.FLOAT,
                false,
                stride * 4,
                offset,
            );
            return offset + f.size * 4;
        }, 0);
    }

    const [pushTexture2D, popTexture2D] = genStack<WebGLTexture>((t) =>
        gl.bindTexture(gl.TEXTURE_2D, t)
    );

    const [pushArrayBuffer, popArrayBuffer] = genStack<WebGLBuffer>((b) =>
        gl.bindBuffer(gl.ARRAY_BUFFER, b)
    );

    const [pushElementArrayBuffer, popElementArrayBuffer] = genStack<
        WebGLBuffer
    >((b) => gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b));

    const [pushFramebuffer, popFramebuffer] = genStack<WebGLFramebuffer>((b) =>
        gl.bindFramebuffer(gl.FRAMEBUFFER, b)
    );

    const [pushRenderbuffer, popRenderbuffer] = genStack<WebGLRenderbuffer>((
        b,
    ) => gl.bindRenderbuffer(gl.RENDERBUFFER, b));

    const [pushViewport, popViewport] = genStack<
        { x: number; y: number; w: number; h: number }
    >((stack) => {
        if (!stack) return;
        const { x, y, w, h } = stack;

        gl.viewport(x, y, w, h);
    });

    const [pushProgram, popProgram] = genStack<WebGLProgram>((p) =>
        gl.useProgram(p)
    );

    pushViewport({
        x: 0,
        y: 0,
        w: gl.drawingBufferWidth,
        h: gl.drawingBufferHeight,
    });

    return {
        gl,
        opts,
        onDestroy,
        destroy,
        pushTexture2D,
        popTexture2D,
        pushArrayBuffer,
        popArrayBuffer,
        pushElementArrayBuffer,
        popElementArrayBuffer,
        pushFramebuffer,
        popFramebuffer,
        pushRenderbuffer,
        popRenderbuffer,
        pushViewport,
        popViewport,
        pushProgram,
        popProgram,
        setVertexFormat,
    };
}
