// ?veg=raster (or a VITE_VEG=raster build): the jose flora, drawn as meshes up close and
// by the compute-shader voxel rasterizer beyond, replaces the original plains plants.
export const VEG_RASTER = ( new URLSearchParams( location.search ).get( 'veg' ) ?? import.meta.env.VITE_VEG ) === 'raster';
