import { expect, test } from "@playwright/test";

test("a cropped sprite records its own vertices after a larger polygon", async ({ page }) => {
    await page.addScriptTag({ path: "dist/kaplay.js" });

    const geometry = await page.evaluate(() => {
        const k = kaplay({ global: false });
        const bean = k.loadBean();

        return new Promise(resolve => {
            k.onLoad(() => {
                const sprite = new k.SpriteData([{
                    tex: bean.data!.frames[0].tex,
                    q: k.quad(0.125, 0.25, 0.5, 0.5),
                }]);

                k.beginPicture();
                k.drawPolygon({
                    pts: [[0, 0], [2, 0], [3, 1], [2, 2], [0, 2]].map(
                        ([x, y]) => k.vec2(x, y),
                    ),
                });
                k.drawSprite({
                    sprite,
                    pos: k.vec2(10, 20),
                    width: 12,
                    height: 8,
                    quad: k.quad(0.25, 0.5, 0.5, 0.25),
                    flipX: true,
                    flipY: true,
                });
                const picture = k.endPicture();

                resolve({
                    vertexCount: picture.vertices.length / 8,
                    spriteIndices: picture.indices.slice(-6),
                    spriteCorners: [5, 6, 7, 8].map(index =>
                        picture.vertices.slice(index * 8, index * 8 + 4)
                    ),
                });
            });
        });
    });

    expect(geometry).toEqual({
        vertexCount: 9,
        spriteIndices: [5, 6, 8, 6, 7, 8],
        spriteCorners: [
            [10, 28, 0.5, 0.5],
            [10, 20, 0.5, 0.625],
            [22, 20, 0.25, 0.625],
            [22, 28, 0.25, 0.5],
        ],
    });
});
