// Every dimension of the generated test models, in one place.
//
// All lengths are in millimetres. Stations are measured along the rocket axis
// from the aft end of the boattail (station 0) towards the nose.
// The rocket is a small sounding rocket: 100 mm diameter, about 1.45 m long.

export const rocket = {
  // Body tube.
  bodyRadius: 50,
  bodyInnerRadius: 47, // only used by the hollow "internals" model
  tubeLength: 1000,

  // Boattail: a cone frustum at the aft end, from tailRadius (aft) to bodyRadius.
  boattailLength: 100,
  tailRadius: 38,
  tailInnerRadius: 35, // hollow model only: the aft end is open

  // Tangent ogive nose.
  noseLength: 350,

  // Fins: a trapezoid planform. "Root" stations are measured from the aft end
  // of the body tube (not from station 0), so that lengthening the tube only
  // moves things forward of the fins.
  finCount: 4,
  finRootTrailingFromTubeAft: 20,
  finRootChord: 150,
  finTipChord: 60,
  finTipTrailingOffset: 10, // tip trailing edge is this far forward of the root trailing edge
  finSpan: 110, // from the body surface to the tip
  finThickness: 4,
  finRootFilletRadius: 6,
  // The fin plate starts this far inside the body surface so the boolean union
  // has a proper overlap. Less than the wall thickness of the hollow tube (3 mm),
  // so the fin does not poke into the bore.
  finRootEmbed: 2,

  // Canards: smaller trapezoids near the forward end of the tube, no fillets.
  canardCount: 4,
  canardRootLeadingFromTubeFore: 120, // root leading edge station, measured aft from the tube's forward end
  canardRootChord: 70,
  canardTipChord: 25,
  canardTipLeadingOffset: 20, // tip leading edge is this far aft of the root leading edge
  canardSpan: 50,
  canardThickness: 3,
  canardRootEmbed: 2,
  // Canards are offset in roll from the fins by this angle (degrees).
  canardRollOffsetDegrees: 45,

  // Internals (hollow model only).
  motorTubeOuterRadius: 29,
  motorTubeInnerRadius: 27,
  motorTubeAftStation: 10, // recessed 10 mm inside the open boattail
  motorTubeLength: 500,
  sledLength: 300,
  sledWidth: 80,
  sledThickness: 4,
  sledAftStation: 750,
  sledBulkheadRadius: 45,
  sledBulkheadThickness: 6,
};

// The lengthened model: the same rocket with the body tube 10 mm longer.
export const tubeLengthening = 10;

// Simple analytic test shapes.
export const plainCylinder = {
  radius: 50,
  length: 200,
};

export const plainCone = {
  baseRadius: 50,
  length: 300,
};

export const ogiveNose = {
  baseRadius: 50,
  length: 350,
};

// The spline body: radius at a few stations. The surface through these circles
// is a lofted B-spline face, not a surface of revolution in the STEP file,
// though it is axisymmetric in fact.
export const splineBody = {
  stations: [0, 120, 260, 400, 520],
  radii: [40, 49, 56, 52, 44],
};

// How each model is placed in the world. Most CAD files have the rocket axis on
// a coordinate axis, but not always, and not always through the origin. At least
// one model must be off-axis so that axis detection is really tested.
//   axis: the direction from tail to nose (does not need to be unit length)
//   origin: where station 0 ends up
//   rollDegrees: roll of the model about its own axis before placing it
export interface Placement {
  axis: [number, number, number];
  origin: [number, number, number];
  rollDegrees: number;
}

export const placements: Record<string, Placement> = {
  'cylinder-two-halves': { axis: [0, 0, 1], origin: [0, 0, 0], rollDegrees: 0 },
  cone: { axis: [1, 0, 0], origin: [-100, 20, 0], rollDegrees: 0 },
  'ogive-nose': { axis: [0, -1, 0], origin: [0, 0, 0], rollDegrees: 0 },
  'spline-body': { axis: [1, 1, 1], origin: [10, 20, 30], rollDegrees: 0 },
  'rocket-assembly': { axis: [0, 0, 1], origin: [0, 0, 0], rollDegrees: 0 },
  'rocket-fused': { axis: [0.3, 1, -0.4], origin: [120, -40, 60], rollDegrees: 10 },
  'rocket-internals': { axis: [1, 0, 0], origin: [0, 0, 0], rollDegrees: 22.5 },
  'rocket-long': { axis: [0, 0, 1], origin: [0, 0, 0], rollDegrees: 0 },
};

// The cone file is written in inches, to test that the importer honours the
// unit declared in the STEP file.
export const inchModels = ['cone'];
