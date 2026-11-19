// Every dimension of the generated test models, in millimetres, in one place.
//
// The parts are sized to assemble into one rocket of 66 mm diameter:
//   nose cone (shoulder goes into the tube) - body tube - can (threaded spigot
//   goes up into the tube, internals hang down into the boattail) - boattail,
//   with four fins on the tube, canards optional, a sled inside.
//
// Each part is modelled in its own local frame: axis along +Z, aft end at
// z = 0 unless noted. `placements` then moves each file somewhere arbitrary,
// because real files arrive that way.

export const body = {
  outerRadius: 33,
  wall: 1.5, // inner radius 31.5
};

export const nose = {
  length: 170, // ogive, base to tip
  wall: 1.6,
  innerLength: 165, // the inner ogive stops short of the tip
  baseLip: 3, // solid ring at the base joining the ogive shell to the shoulder
  shoulderOuterRadius: 31.4, // slides into the tube (inner radius 31.5)
  shoulderInnerRadius: 29.9,
  shoulderLength: 30,
};

export const tube = {
  length: 260,
};

// Modelled on the team's own "can" section: a short waisted shell with a
// window, a threaded male spigot at the top, and internal structure that is
// fused into the same solid and hangs about 70 mm out of the open bottom.
export const can = {
  shellHeight: 40,
  endRadius: 33, // outer radius at both ends of the shell
  waistRadius: 30, // outer radius at mid height (concave profile)
  innerRadius: 28,
  windowRadius: 10, // 20 mm round window through the wall
  windowHeight: 20,
  smallHoleRadius: 1.5,
  smallHoleHeight: 6,
  smallHoleCount: 4,
  spigotLength: 12,
  spigotCoreRadius: 30,
  spigotBoreRadius: 27,
  threadPitch: 2,
  threadTurns: 5,
  threadStart: 41, // z where the helix starts (just above the shoulder step)
  threadCrestRadius: 31.2,
  threadRootRadius: 29.8, // the profile starts a little inside the core so the fuse overlaps
  threadHalfWidth: 0.8, // half the axial width of the thread profile at its root
  strutCount: 3,
  strutThickness: 3,
  strutInnerRadius: 8,
  strutOuterRadius: 28.5, // overlaps the shell wall by 0.5 mm so it fuses
  strutTop: 30,
  strutBottom: -60,
  strutBottomOuterRadius: 18, // struts taper below the shell to clear the boattail
  blockHalfSize: 8,
  blockBottom: -20,
  blockTop: 20,
  legRadius: 2,
  legPitchRadius: 13.5,
  ringOuterRadius: 15,
  ringInnerRadius: 12,
  ringTop: -66,
  ringBottom: -70, // the internals reach 70 mm below the open end
};

export const boattail = {
  length: 70,
  foreRadius: 33,
  aftRadius: 24,
  wall: 1.5,
};

// Fin: flat plate, swept trapezoid planform, leading edge, trailing edge and
// tip rounded, root edge flat and square (it is glued to the tube).
// Local frame: root along z (z = 0 at the root trailing edge), span along +x,
// thickness along y.
export const fin = {
  rootChord: 110,
  tipChord: 50,
  span: 55,
  sweep: 60, // how far aft the tip leading edge sits behind the root leading edge
  thickness: 3,
  edgeRadius: 1.2,
};

export const canard = {
  rootChord: 50,
  tipChord: 25,
  span: 30,
  sweep: 25,
  thickness: 2.5,
  edgeRadius: 1.0,
};

// Avionics sled: a board between two bulkhead discs. Fits inside the tube.
export const sled = {
  boardWidth: 50,
  boardLength: 120,
  boardThickness: 3,
  bulkheadRadius: 30,
  bulkheadThickness: 4,
};

// Where the parts sit in the whole-rocket files (station = z along the
// rocket, 0 at the boattail aft end).
export const rocketStations = {
  boattailAft: 0,
  tubeAft: 70, // boattail.length
  tubeFore: 330, // tubeAft + tube.length
  finRootTrailing: 80, // fins sit on the tube, 10 mm above its aft end
};

// How each file is placed in its own coordinate system: the part's local +Z
// (its long axis) is turned onto `axis`, rolled by rollDegrees, and moved to
// `origin`. Deliberately not all along Z.
export interface Placement {
  axis: [number, number, number];
  origin: [number, number, number];
  rollDegrees: number;
}

export const placements: Record<string, Placement> = {
  nose: { axis: [0, -1, 0], origin: [40, 250, -12], rollDegrees: 0 },
  tube: { axis: [1, 0, 0], origin: [-130, 0, 0], rollDegrees: 0 },
  can: { axis: [0.3, 0.2, 1], origin: [15, -8, 3], rollDegrees: 30 },
  boattail: { axis: [0, 0, -1], origin: [0, 0, 70], rollDegrees: 0 },
  fin: { axis: [0, 1, 0], origin: [10, 0, 20], rollDegrees: 90 },
  canard: { axis: [1, 1, 0], origin: [0, 0, 0], rollDegrees: 0 },
  sled: { axis: [0, 0, 1], origin: [0, 0, 0], rollDegrees: 45 },
  assembly: { axis: [0, 1, 0], origin: [0, 0, 0], rollDegrees: 0 },
  rocket: { axis: [0.2, -1, 0.5], origin: [100, 50, -30], rollDegrees: 10 },
};

// The canard file is written in inches, to test that import honours the
// file's length unit.
export const inchFiles = ['canard'];
