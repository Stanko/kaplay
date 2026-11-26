import { DEF_HASH_GRID_SIZE } from "../../constants/general";
import {
    type AreaComp,
    getLocalAreaVersion,
    getRenderAreaVersion,
} from "../../ecs/components/physics/area";
import {
    getTransformVersion,
    objectTransformNeedsUpdate,
} from "../../ecs/entity/GameObjRaw";
import { exists, isPaused } from "../../ecs/entity/utils";
import type { GameObj } from "../../types";
import type { Rect } from "../math";
import { calcTransform } from "../various";

export type HashGridOpt = {
    hashGridSize?: number;
};

type AreaObject = GameObj<AreaComp>;

type GridEntry = {
    cellIndices: number[];
    transformVersion: number;
    renderAreaVersion: number | undefined;
    localAreaVersion: number;
};

export class HashGrid {
    private readonly bounds: Rect;
    private readonly cellSize: number;
    private columns = 0;
    private rows = 0;
    private cells: AreaObject[][] = [];
    private readonly entriesByObject = new Map<AreaObject, GridEntry>();
    private readonly cellIndexScratch: number[] = [];

    constructor(bounds: Rect, opt: HashGridOpt) {
        this.bounds = bounds.clone();
        this.cellSize = opt.hashGridSize || DEF_HASH_GRID_SIZE;
        this.setBounds(
            bounds.pos.x,
            bounds.pos.y,
            bounds.pos.x + bounds.width,
            bounds.pos.y + bounds.height,
        );
    }

    add(object: AreaObject) {
        const bounds = object.worldBbox();
        if (!this.containsBounds(bounds)) {
            this.resizeToFit(bounds);
        }

        const cellIndices: number[] = [];
        this.writeCellIndices(bounds, cellIndices);
        for (const cellIndex of cellIndices) {
            this.addToCell(object, cellIndex);
        }

        this.entriesByObject.set(object, {
            cellIndices,
            transformVersion: getTransformVersion(object),
            renderAreaVersion: getRenderAreaVersion(object),
            localAreaVersion: getLocalAreaVersion(object),
        });
    }

    remove(object: AreaObject) {
        const entry = this.entriesByObject.get(object);
        if (entry) {
            for (const cellIndex of entry.cellIndices) {
                this.removeFromCell(object, cellIndex);
            }
            this.entriesByObject.delete(object);
        }
    }

    clear() {
        this.cells = [];
        this.entriesByObject.clear();
    }

    update() {
        const nextCells = this.cellIndexScratch;
        for (const [object, entry] of this.entriesByObject) {
            const transformVersion = getTransformVersion(object);
            const renderAreaVersion = getRenderAreaVersion(object);
            const localAreaVersion = getLocalAreaVersion(object);
            if (
                entry.transformVersion === transformVersion
                && entry.renderAreaVersion === renderAreaVersion
                && entry.localAreaVersion === localAreaVersion
            ) {
                continue;
            }

            if (objectTransformNeedsUpdate(object)) {
                calcTransform(object, object.transform);
            }
            else {
                entry.transformVersion = transformVersion;
            }
            entry.renderAreaVersion = renderAreaVersion;
            entry.localAreaVersion = localAreaVersion;

            this.writeCellIndices(object.worldBbox(), nextCells);
            const previousCells = entry.cellIndices;
            if (!sameCellIndices(previousCells, nextCells)) {
                this.updateCellMembership(object, previousCells, nextCells);
            }
        }
    }

    /** Visits each potential collision pair once. */
    iterPairs(onPair: (object: AreaObject, candidate: AreaObject) => void) {
        const cellsAtStart = this.cells;
        const processedObjects = new Set<AreaObject>();

        // Earlier collision callbacks can change which objects are eligible.
        for (const [object, { cellIndices }] of this.entriesByObject) {
            // Rebuilding replaces the cells and can reinsert visited objects.
            if (this.cells !== cellsAtStart && processedObjects.has(object)) {
                continue;
            }
            if (!isCollisionEligible(object)) continue;
            processedObjects.add(object);

            const candidates = new Set<AreaObject>();
            for (let i = 0; i < cellIndices.length; i++) {
                const cell = this.cells[cellIndices[i]];
                for (let j = 0; j < cell.length; j++) {
                    const candidate = cell[j];
                    if (
                        !processedObjects.has(candidate)
                        && isCollisionEligible(candidate)
                    ) {
                        candidates.add(candidate);
                    }
                }
            }

            for (const candidate of candidates) {
                onPair(object, candidate);
            }
        }
    }

    /** Visits objects in the cells covered by the rectangle. */
    retrieve(rect: Rect, onMatch: (object: AreaObject) => void) {
        const cellIndices = this.cellIndexScratch;
        this.writeCellIndices(rect, cellIndices);

        const matches = new Set<AreaObject>();
        for (let i = 0; i < cellIndices.length; i++) {
            const cell = this.cells[cellIndices[i]];
            if (cell) {
                for (let j = 0; j < cell.length; j++) {
                    matches.add(cell[j]);
                }
            }
        }

        matches.forEach(onMatch);
    }

    private writeCellIndices(rect: Rect, cellIndices: number[]) {
        const gridLeft = this.bounds.pos.x;
        const gridTop = this.bounds.pos.y;
        const left = Math.max(rect.pos.x, gridLeft);
        const top = Math.max(rect.pos.y, gridTop);
        const right = Math.min(
            rect.pos.x + rect.width,
            gridLeft + this.bounds.width,
        );
        const bottom = Math.min(
            rect.pos.y + rect.height,
            gridTop + this.bounds.height,
        );
        if (left > right || top > bottom) {
            cellIndices.length = 0;
            return;
        }

        // Include both edges so touching rectangles share a cell.
        const firstColumn = Math.min(
            this.columns - 1,
            Math.floor((left - gridLeft) / this.cellSize),
        );
        const lastColumn = Math.min(
            this.columns - 1,
            Math.floor((right - gridLeft) / this.cellSize),
        );
        const firstRow = Math.min(
            this.rows - 1,
            Math.floor((top - gridTop) / this.cellSize),
        );
        const lastRow = Math.min(
            this.rows - 1,
            Math.floor((bottom - gridTop) / this.cellSize),
        );

        // Row-major order gives the membership update a sorted, unique list.
        let count = 0;
        for (let row = firstRow; row <= lastRow; row++) {
            const rowStart = row * this.columns;
            for (let column = firstColumn; column <= lastColumn; column++) {
                cellIndices[count++] = rowStart + column;
            }
        }
        cellIndices.length = count;
    }

    private updateCellMembership(
        object: AreaObject,
        previousCells: number[],
        nextCells: number[],
    ) {
        let previousIndex = 0;
        let nextIndex = 0;
        while (
            previousIndex < previousCells.length && nextIndex < nextCells.length
        ) {
            const previousCell = previousCells[previousIndex];
            const nextCell = nextCells[nextIndex];
            if (previousCell === nextCell) {
                previousIndex++;
                nextIndex++;
            }
            else if (previousCell < nextCell) {
                this.removeFromCell(object, previousCell);
                previousIndex++;
            }
            else {
                this.addToCell(object, nextCell);
                nextIndex++;
            }
        }
        for (; previousIndex < previousCells.length; previousIndex++) {
            this.removeFromCell(object, previousCells[previousIndex]);
        }
        for (; nextIndex < nextCells.length; nextIndex++) {
            this.addToCell(object, nextCells[nextIndex]);
        }

        previousCells.length = nextCells.length;
        for (let i = 0; i < nextCells.length; i++) {
            previousCells[i] = nextCells[i];
        }
    }

    private addToCell(object: AreaObject, cellIndex: number) {
        (this.cells[cellIndex] ??= []).push(object);
    }

    private removeFromCell(object: AreaObject, cellIndex: number) {
        const cell = this.cells[cellIndex];
        const index = cell.indexOf(object);
        if (index >= 0) {
            cell.splice(index, 1);
        }
    }

    private containsBounds(rect: Rect) {
        return rect.pos.x >= this.bounds.pos.x
            && rect.pos.y >= this.bounds.pos.y
            && rect.pos.x + rect.width <= this.bounds.pos.x + this.bounds.width
            && rect.pos.y + rect.height
                <= this.bounds.pos.y + this.bounds.height;
    }

    private resizeToFit(rect: Rect) {
        this.setBounds(
            Math.min(this.bounds.pos.x, rect.pos.x),
            Math.min(this.bounds.pos.y, rect.pos.y),
            Math.max(
                this.bounds.pos.x + this.bounds.width,
                rect.pos.x + rect.width,
            ),
            Math.max(
                this.bounds.pos.y + this.bounds.height,
                rect.pos.y + rect.height,
            ),
        );

        const objects = [...this.entriesByObject.keys()];
        this.clear();
        for (const object of objects) {
            this.add(object);
        }
    }

    private setBounds(
        left: number,
        top: number,
        right: number,
        bottom: number,
    ) {
        const firstColumn = Math.floor(left / this.cellSize);
        const firstRow = Math.floor(top / this.cellSize);
        this.columns = Math.max(
            1,
            Math.ceil(right / this.cellSize) - firstColumn,
        );
        this.rows = Math.max(1, Math.ceil(bottom / this.cellSize) - firstRow);
        this.bounds.pos.x = firstColumn * this.cellSize;
        this.bounds.pos.y = firstRow * this.cellSize;
        this.bounds.width = this.columns * this.cellSize;
        this.bounds.height = this.rows * this.cellSize;
    }
}

function sameCellIndices(previousCells: number[], nextCells: number[]) {
    if (previousCells.length !== nextCells.length) return false;
    for (let i = 0; i < previousCells.length; i++) {
        if (previousCells[i] !== nextCells[i]) return false;
    }
    return true;
}

function isCollisionEligible(object: AreaObject) {
    return exists(object)
        && (object.isSensor || object.has("body"))
        && !isPaused(object);
}
