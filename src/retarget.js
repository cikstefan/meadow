// Retargeting: bake animation clips from one skeleton onto another with a
// different rig (bone names, proportions, rest orientations).
//
// Method: rotation deltas in a shared "body frame" (both skeletons face +Z,
// +Y up, left = +X). For each source bone S and frame t the body-space delta
// from a reference pose is   d = W_S(t) * W_S(ref)^-1.   A target bone T mapped
// to S gets the same delta on top of its own reference orientation,
// W_T(t) = d * W_T(ref), converted back to a parent-local quaternion top-down.
// A target bone can be mapped to a blend of two source bones (slerp of their
// deltas), which spreads e.g. a 3-bone source spine over a 5-bone target spine.
// Root translation is copied as an offset scaled by the leg-length ratio.

import * as THREE from 'three/webgpu';

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();

// body-space world quaternion / position of a node (frame = `frame` object)
function bodyQuat( node, frameInvQ, out ) {

	return node.getWorldQuaternion( out ).premultiply( frameInvQ );

}

/**
 * @param {object} o
 * @param {THREE.Object3D} o.srcRoot      source skeleton root (its frame is the source body frame)
 * @param {THREE.AnimationClip[]} o.clips source clips to bake
 * @param {THREE.AnimationClip} o.refClip source clip whose first frame is the reference pose
 * @param {THREE.Object3D} o.dstFrame     target body frame
 * @param {object} o.dstBones             name -> target node
 * @param {Array} o.map                   [ targetName, srcA, srcB?, k? ] parent-first order
 * @param {string} o.rootDst / o.rootSrc  bones whose translation is copied
 * @param {number} o.posScale             target metres per source unit
 * @param {number} [o.fps=30]
 * @returns {THREE.AnimationClip[]} clips for the target
 */
export function retargetClips( o ) {

	const fps = o.fps || 30;
	const { srcRoot, dstFrame, dstBones, map } = o;
	const srcNode = {};
	srcRoot.traverse( ( n ) => {

		if ( n.name && ! srcNode[ n.name ] ) srcNode[ n.name ] = n;

	} );

	const srcInvQ = srcRoot.getWorldQuaternion( new THREE.Quaternion() ).invert();
	const dstInvQ = dstFrame.getWorldQuaternion( new THREE.Quaternion() ).invert();
	const dstInvM = new THREE.Matrix4().copy( dstFrame.matrixWorld ).invert();

	const srcNames = new Set();
	for ( const [ , a, b ] of map ) {

		srcNames.add( a ); if ( b ) srcNames.add( b );

	}

	for ( const n of srcNames ) if ( ! srcNode[ n ] ) throw new Error( 'retarget: missing source bone ' + n );

	// --- reference poses
	const mixer = new THREE.AnimationMixer( srcRoot );
	const sample = ( clip, t ) => {

		mixer.stopAllAction();
		const a = mixer.clipAction( clip );
		a.reset().play();
		mixer.setTime( Math.min( t, clip.duration - 1e-4 ) );
		srcRoot.updateMatrixWorld( true );

	};

	sample( o.refClip, 0 );
	const srcRefInv = {};
	for ( const n of srcNames ) srcRefInv[ n ] = bodyQuat( srcNode[ n ], srcInvQ, new THREE.Quaternion() ).invert();
	const srcRootRef = srcNode[ o.rootSrc ].getWorldPosition( new THREE.Vector3() ).applyMatrix4( new THREE.Matrix4().copy( srcRoot.matrixWorld ).invert() );

	dstFrame.updateMatrixWorld( true );
	const dstRestLocal = {}, dstRefW = {};
	for ( const [ t ] of map ) {

		const b = dstBones[ t ];
		dstRestLocal[ t ] = b.quaternion.clone();
		dstRefW[ t ] = bodyQuat( b, dstInvQ, new THREE.Quaternion() );

	}

	const rootB = dstBones[ o.rootDst ];
	const rootRestPos = rootB.position.clone();
	const rootRefBody = rootB.getWorldPosition( new THREE.Vector3() ).applyMatrix4( dstInvM );
	const srcInvM = new THREE.Matrix4().copy( srcRoot.matrixWorld ).invert();

	const out = [];
	const delta = {};
	for ( const clip of o.clips ) {

		const n = Math.max( 2, Math.round( clip.duration * fps ) + 1 );
		const times = new Float32Array( n );
		const qv = {};
		for ( const [ t ] of map ) qv[ t ] = new Float32Array( n * 4 );
		const pv = new Float32Array( n * 3 );

		for ( let f = 0; f < n; f ++ ) {

			const time = clip.duration * f / ( n - 1 );
			times[ f ] = time;
			// last frame: sample just before the end (the mixer wraps at t = duration)
			sample( clip, f === n - 1 ? clip.duration - 1e-3 : time );
			for ( const s of srcNames ) delta[ s ] = bodyQuat( srcNode[ s ], srcInvQ, new THREE.Quaternion() ).multiply( srcRefInv[ s ] );

			// root translation (body frame offset, scaled)
			const sp = srcNode[ o.rootSrc ].getWorldPosition( _v ).applyMatrix4( srcInvM ).sub( srcRootRef ).multiplyScalar( o.posScale );
			const wp = rootRefBody.clone().add( sp ).applyMatrix4( dstFrame.matrixWorld );
			rootB.parent.updateWorldMatrix( true, false );
			rootB.position.copy( rootB.parent.worldToLocal( wp ) );
			rootB.position.toArray( pv, f * 3 );

			// rotations, parent first
			for ( const [ t, a, b, k ] of map ) {

				const d = b ? _q.copy( delta[ a ] ).slerp( delta[ b ], k ) : _q.copy( delta[ a ] );
				const wT = _q2.copy( d ).multiply( dstRefW[ t ] ); // desired body-space orientation
				const node = dstBones[ t ];
				const parentW = bodyQuat( node.parent, dstInvQ, new THREE.Quaternion() );
				node.quaternion.copy( parentW.invert().multiply( wT ) );
				node.quaternion.toArray( qv[ t ], f * 4 );

			}

		}

		// make quaternion tracks continuous (no sign flips)
		for ( const [ t ] of map ) {

			const a = qv[ t ];
			for ( let f = 1; f < n; f ++ ) {

				const i = f * 4, j = i - 4;
				if ( a[ i ] * a[ j ] + a[ i + 1 ] * a[ j + 1 ] + a[ i + 2 ] * a[ j + 2 ] + a[ i + 3 ] * a[ j + 3 ] < 0 ) for ( let c = 0; c < 4; c ++ ) a[ i + c ] = - a[ i + c ];

			}

		}

		const tracks = map.map( ( [ t ] ) => new THREE.QuaternionKeyframeTrack( dstBones[ t ].uuid + '.quaternion', times, qv[ t ] ) );
		tracks.push( new THREE.VectorKeyframeTrack( rootB.uuid + '.position', times, pv ) );
		out.push( new THREE.AnimationClip( clip.name.replace( /\s+/g, ' ' ).trim(), clip.duration, tracks ) );

	}

	// restore the target rest pose
	for ( const [ t ] of map ) dstBones[ t ].quaternion.copy( dstRestLocal[ t ] );
	rootB.position.copy( rootRestPos );
	mixer.stopAllAction();
	return out;

}

/**
 * Ground speed of an in-place locomotion clip: how fast the planted paws move
 * backward (source units / s), median over all stance samples.
 */
export function stanceSpeed( srcRoot, clip, toeNames, fps = 120 ) {

	const mixer = new THREE.AnimationMixer( srcRoot );
	mixer.clipAction( clip ).play();
	const inv = new THREE.Matrix4();
	const nodes = toeNames.map( ( n ) => srcRoot.getObjectByName( n ) );
	const n = Math.round( clip.duration * fps );
	const pos = nodes.map( () => [] );
	for ( let f = 0; f <= n; f ++ ) {

		mixer.setTime( Math.min( clip.duration * f / n, clip.duration - 1e-4 ) );
		srcRoot.updateMatrixWorld( true );
		inv.copy( srcRoot.matrixWorld ).invert();
		nodes.forEach( ( node, i ) => pos[ i ].push( node.getWorldPosition( new THREE.Vector3() ).applyMatrix4( inv ) ) );

	}

	mixer.stopAllAction();
	const speeds = [];
	for ( const p of pos ) {

		const minY = Math.min( ...p.map( ( q ) => q.y ) );
		for ( let f = 1; f < p.length; f ++ ) {

			if ( p[ f ].y < minY + 0.02 && p[ f - 1 ].y < minY + 0.02 ) speeds.push( - ( p[ f ].z - p[ f - 1 ].z ) * fps );

		}

	}

	speeds.sort( ( a, b ) => a - b );
	return speeds.length ? Math.max( 0.1, speeds[ speeds.length >> 1 ] ) : 1;

}
