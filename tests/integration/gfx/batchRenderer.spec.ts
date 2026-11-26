import { expect, test } from "@playwright/test";

test("batch growth skips empty geometry and preserves 16-bit indices", async ({ page }) => {
    await page.addScriptTag({ path: "dist/kaplay.js" });

    const batches = await page.evaluate(() => {
        const k = kaplay({
            global: false,
            width: 64,
            height: 64,
            debug: false,
        });

        return new Promise(resolve => {
            k.onLoad(() => {
                const { gl, renderer } = k._k.gfx;
                const originalUpload = gl.bufferSubData;
                const uploads: number[][] = [];
                gl.bufferSubData = function(target, offset, data) {
                    if (
                        target === gl.ELEMENT_ARRAY_BUFFER
                        && data instanceof Uint16Array
                    ) {
                        uploads.push(Array.from(data));
                    }
                    originalUpload.call(this, target, offset, data);
                };

                const flush = () => renderer.flush(k.width(), k.height());
                const triangle = [k.vec2(1, 1), k.vec2(2, 1), k.vec2(1, 2)];
                const sparsePoints = (count: number) =>
                    new Array(count).fill(triangle[0]);

                k.drawPolygon({ pts: triangle, indices: [], fixed: true });
                // Exceed the default capacity of both queues in one draw.
                k.drawPolygon({
                    pts: sparsePoints(8193),
                    indices: Array.from(
                        { length: 12_291 },
                        (_, i) => 8190 + i % 3,
                    ),
                    fixed: true,
                });
                flush();
                const afterEmpty = uploads.splice(0).map(indices => ({
                    count: indices.length,
                    firstTriangle: indices.slice(0, 3),
                }));

                // Grow beyond the 16-bit address range with a sparse draw.
                const oversized = sparsePoints(65_540);
                k.drawPolygon({
                    pts: oversized,
                    indices: [0, 1, 2],
                    fixed: true,
                });
                flush();
                uploads.length = 0;

                const points = sparsePoints(8192);
                for (let i = 0; i < 8; i++) {
                    k.drawPolygon({
                        pts: points,
                        indices: [0, 1, 2],
                        fixed: true,
                    });
                }
                k.drawPolygon({
                    pts: triangle,
                    indices: [0, 1, 2],
                    fixed: true,
                });
                flush();
                const afterGrowth = uploads.map(indices => ({
                    count: indices.length,
                    lastTriangle: indices.slice(-3),
                }));

                let overflowMessage = "";
                try {
                    k.drawPolygon({
                        pts: oversized,
                        indices: [65_535, 65_536, 65_537],
                        fixed: true,
                    });
                } catch (error) {
                    if (error instanceof RangeError) {
                        overflowMessage = error.message;
                    }
                }

                gl.bufferSubData = originalUpload;
                resolve({
                    afterEmpty,
                    afterGrowth,
                    overflowMessage,
                    error: gl.getError(),
                });
            });
        });
    });

    expect(batches).toEqual({
        afterEmpty: [{ count: 12_291, firstTriangle: [8190, 8191, 8192] }],
        afterGrowth: [
            { count: 24, lastTriangle: [57_344, 57_345, 57_346] },
            { count: 3, lastTriangle: [0, 1, 2] },
        ],
        overflowMessage: "Draw exceeds the 16-bit vertex index range",
        error: 0,
    });
});
