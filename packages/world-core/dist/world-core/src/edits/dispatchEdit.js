const inBounds = (world, x, y) => x >= 0 && y >= 0 && x < world.map.width && y < world.map.height;
const id = () => Math.random().toString(36).slice(2, 10);
export const dispatchEdit = (world, cmd) => {
    switch (cmd.type) {
        case "PLACE_TILE": {
            if (!inBounds(world, cmd.x, cmd.y))
                return { ok: false, message: "out_of_bounds" };
            world.map[cmd.layer][cmd.y][cmd.x] = cmd.tileId;
            world.revision += 1;
            return { ok: true, message: "tile_placed" };
        }
        case "ERASE_TILE": {
            if (!inBounds(world, cmd.x, cmd.y))
                return { ok: false, message: "out_of_bounds" };
            world.map[cmd.layer][cmd.y][cmd.x] = 0;
            world.revision += 1;
            return { ok: true, message: "tile_erased" };
        }
        case "PLACE_STRUCTURE": {
            const s = {
                id: `s-${id()}`,
                type: cmd.structureType,
                x: cmd.x,
                y: cmd.y,
                width: cmd.width,
                height: cmd.height,
                assetKey: cmd.assetKey,
                props: cmd.props ?? {}
            };
            world.structures[s.id] = s;
            world.revision += 1;
            return { ok: true, message: "structure_placed" };
        }
        case "MOVE_STRUCTURE": {
            const s = world.structures[cmd.structureId];
            if (!s)
                return { ok: false, message: "structure_not_found" };
            s.x = cmd.x;
            s.y = cmd.y;
            world.revision += 1;
            return { ok: true, message: "structure_moved" };
        }
        case "REMOVE_STRUCTURE": {
            if (!world.structures[cmd.structureId])
                return { ok: false, message: "structure_not_found" };
            delete world.structures[cmd.structureId];
            world.revision += 1;
            return { ok: true, message: "structure_removed" };
        }
        case "UPDATE_STRUCTURE_PROPERTY": {
            const s = world.structures[cmd.structureId];
            if (!s)
                return { ok: false, message: "structure_not_found" };
            s.props[cmd.key] = cmd.value;
            world.revision += 1;
            return { ok: true, message: "structure_property_updated" };
        }
    }
    return { ok: false, message: "unknown_edit" };
};
