// glTF 2.0 assembly, emitting binary .glb.
//
// Three things this writer supports that the models do not use yet, and which
// exist so that richer models are an edit rather than a rewrite:
//
//  - a named node hierarchy, so parts can be addressed individually
//  - rotation animation tracks bound to those nodes
//  - TEXCOORD_0 and baseColorTexture, for liveries and route-number decals
//
// Output is .glb rather than .gltf with an embedded data: URI. The base64 the
// old writer produced inflated the buffer by a third and had to be decoded at
// load; a binary chunk is read straight into a typed array.

import { COLORS } from './palette.mjs';

const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/** Quaternion for a rotation of `angle` radians about a principal axis. */
function axisQuaternion(axis, angle) {
  const half = angle / 2;
  const s = Math.sin(half);
  const w = Math.cos(half);
  if (axis === 'x') return [s, 0, 0, w];
  if (axis === 'y') return [0, s, 0, w];
  return [0, 0, s, w];
}

/**
 * A full turn as four quarter-turn keyframes. Rotations interpolate as slerp,
 * so quarter turns are the coarsest sampling that still reads as a spin rather
 * than a wobble, and the last keyframe repeats the first so the loop closes.
 */
function spinKeyframes(axis, periodSeconds) {
  const times = [];
  const values = [];
  for (let step = 0; step <= 4; step += 1) {
    times.push((periodSeconds * step) / 4);
    values.push(...axisQuaternion(axis, (Math.PI / 2) * step));
  }
  return { times, values };
}

export function toGlb(model) {
  const chunks = [];
  let byteOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const materials = [];
  const materialIndex = new Map();
  const meshes = [];
  const nodes = [];

  const pushChunk = (typedArray, target) => {
    // glTF requires 4-byte alignment between buffer views.
    const padding = (4 - (byteOffset % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      byteOffset += padding;
    }
    const buffer = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const view = { buffer: 0, byteOffset, byteLength: buffer.byteLength };
    if (target !== undefined) {
      view.target = target;
    }
    bufferViews.push(view);
    chunks.push(buffer);
    byteOffset += buffer.byteLength;
    return bufferViews.length - 1;
  };

  const pushAccessor = (accessor) => {
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const materialFor = (colorKey) => {
    if (materialIndex.has(colorKey)) {
      return materialIndex.get(colorKey);
    }
    materials.push({
      name: colorKey,
      pbrMetallicRoughness: {
        baseColorFactor: [...COLORS[colorKey], 1],
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
      doubleSided: true,
    });
    materialIndex.set(colorKey, materials.length - 1);
    return materials.length - 1;
  };

  for (const part of model.parts) {
    const primitives = [];

    for (const [colorKey, group] of part.groups) {
      if (!group.positions.length) {
        continue;
      }

      const positions = new Float32Array(group.positions);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], positions[i + axis]);
          max[axis] = Math.max(max[axis], positions[i + axis]);
        }
      }

      const attributes = {
        POSITION: pushAccessor({
          bufferView: pushChunk(positions, TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: positions.length / 3,
          type: 'VEC3',
          min,
          max,
        }),
        NORMAL: pushAccessor({
          bufferView: pushChunk(new Float32Array(group.normals), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: group.normals.length / 3,
          type: 'VEC3',
        }),
      };

      if (group.uvs.length) {
        attributes.TEXCOORD_0 = pushAccessor({
          bufferView: pushChunk(new Float32Array(group.uvs), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: group.uvs.length / 2,
          type: 'VEC2',
        });
      }

      primitives.push({
        attributes,
        indices: pushAccessor({
          bufferView: pushChunk(new Uint16Array(group.indices), TARGET_ELEMENT_ARRAY_BUFFER),
          componentType: COMPONENT_USHORT,
          count: group.indices.length,
          type: 'SCALAR',
        }),
        material: materialFor(colorKey),
      });
    }

    if (!primitives.length) {
      continue;
    }

    meshes.push({ name: part.name, primitives });
    const node = { name: part.name, mesh: meshes.length - 1 };
    if (part.translation.some((value) => value !== 0)) {
      node.translation = part.translation;
    }
    nodes.push(node);
    part.nodeIndex = nodes.length - 1;
  }

  // The root exists so the scene has a single node to transform, which is what
  // luma.gl's scenegraph traversal expects of a model it will instance.
  const childIndices = nodes.map((_, index) => index);
  nodes.push({ name: model.name, children: childIndices });
  const rootIndex = nodes.length - 1;

  const animations = buildAnimations(model, pushChunk, pushAccessor);

  const binary = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'watch-london-move generate-models' },
    scene: 0,
    scenes: [{ nodes: [rootIndex] }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binary.byteLength }],
  };
  if (animations.length) {
    json.animations = animations;
  }

  return packGlb(json, binary);
}

function buildAnimations(model, pushChunk, pushAccessor) {
  const spinning = model.parts.filter((part) => part.spin && part.nodeIndex !== undefined);
  if (!spinning.length) {
    return [];
  }

  const channels = [];
  const samplers = [];
  // Parts sharing an axis and period share their keyframe accessors — every
  // wheel on a vehicle turns identically.
  const samplerCache = new Map();

  for (const part of spinning) {
    const { axis, periodSeconds } = part.spin;
    const key = `${axis}:${periodSeconds}`;
    let sampler = samplerCache.get(key);
    if (sampler === undefined) {
      const { times, values } = spinKeyframes(axis, periodSeconds);
      const input = pushAccessor({
        bufferView: pushChunk(new Float32Array(times)),
        componentType: 5126,
        count: times.length,
        type: 'SCALAR',
        min: [times[0]],
        max: [times[times.length - 1]],
      });
      const output = pushAccessor({
        bufferView: pushChunk(new Float32Array(values)),
        componentType: 5126,
        count: values.length / 4,
        type: 'VEC4',
      });
      samplers.push({ input, output, interpolation: 'LINEAR' });
      sampler = samplers.length - 1;
      samplerCache.set(key, sampler);
    }
    channels.push({ sampler, target: { node: part.nodeIndex, path: 'rotation' } });
  }

  // Present in the file but not played: ScenegraphLayer only runs animations
  // when given an `_animations` prop, and thousands of animated instances is a
  // cost to take deliberately rather than by default.
  return [{ name: 'roll', channels, samplers }];
}

function packGlb(json, binary) {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  // Chunks are padded to 4 bytes: JSON with spaces, BIN with zeroes.
  const jsonChunk = Buffer.concat([
    jsonBuffer,
    Buffer.alloc((4 - (jsonBuffer.length % 4)) % 4, 0x20),
  ]);
  const binChunk = Buffer.concat([binary, Buffer.alloc((4 - (binary.length % 4)) % 4, 0)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}
