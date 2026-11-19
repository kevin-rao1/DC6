// Tessellation settings, in their own module so that code running on the page
// (not in the import worker) can read them without loading OpenCascade.

// Tessellation settings.
//
// Linear deflection 0.05 mm: the largest distance between a triangle and the
// true surface. On the 100 mm diameter body tube this gives a chord every
// 5.1 degrees (about 70 around), and the sagitta of 0.05 mm is less than half
// a pixel even when the tube fills a 1000-pixel-wide view, so the silhouette
// looks round at full zoom. Shading uses the surface normals from the CAD
// face, so the facets do not show inside the outline either.
// Angular deflection 0.1 rad (5.7 degrees): limits the turn between
// neighbouring triangles on small, tightly curved features (fillets, the nose
// tip) where the linear limit alone would allow coarse triangles.
// Cost on the test rocket: about 40 000 triangles, 0.2-0.5 s to tessellate.
// Doubt: a much larger model (a 3 m rocket with many small parts) may need a
// coarser setting for speed; nothing adapts this yet.
export const linearDeflection = 0.05;
export const angularDeflection = 0.1;
