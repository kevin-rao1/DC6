// The rocket axis in the world.
//
// The rocket is worked on lying horizontal, as OpenRocket shows it: the axis
// is the world X axis through the origin, nose pointing to -X (screen left in
// the side view), tail to +X. World +Y is up. The team may change which way
// the nose points; NOSE_DIRECTION is the one place that decides it.

import type { Vec3 } from './vec3.ts';

export const NOSE_DIRECTION: Vec3 = [-1, 0, 0];

// Toward the tail.
export const AFT_DIRECTION: Vec3 = [-NOSE_DIRECTION[0], -NOSE_DIRECTION[1], -NOSE_DIRECTION[2]];

// A point on the axis. The root part's aft face is centred here.
export const AXIS_ORIGIN: Vec3 = [0, 0, 0];

// World up, used for the camera.
export const WORLD_UP: Vec3 = [0, 1, 0];
