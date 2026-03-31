import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { BufferAttribute, BufferGeometry } from 'three'

type TerrainPreview3DProps = {
  topValues: number[]
  nx: number
  ny: number
  width: number
  height: number
}

function TerrainMesh({ topValues, nx, ny, width, height }: TerrainPreview3DProps) {
  const { geometry, zMid } = useMemo(() => {
    const positions = new Float32Array(nx * ny * 3)
    let zMin = Number.POSITIVE_INFINITY
    let zMax = Number.NEGATIVE_INFINITY

    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const idx = iy * nx + ix
        const x = (ix / Math.max(1, nx - 1)) * width - width * 0.5
        const y = (iy / Math.max(1, ny - 1)) * height - height * 0.5
        const z = topValues[idx]

        const offset = idx * 3
        positions[offset] = x
        positions[offset + 1] = y
        positions[offset + 2] = z

        if (z < zMin) zMin = z
        if (z > zMax) zMax = z
      }
    }

    const indexCount = (nx - 1) * (ny - 1) * 6
    const IndexArray = nx * ny > 65535 ? Uint32Array : Uint16Array
    const indices = new IndexArray(indexCount)
    let cursor = 0

    for (let iy = 0; iy < ny - 1; iy += 1) {
      for (let ix = 0; ix < nx - 1; ix += 1) {
        const v00 = iy * nx + ix
        const v10 = iy * nx + ix + 1
        const v11 = (iy + 1) * nx + ix + 1
        const v01 = (iy + 1) * nx + ix

        indices[cursor++] = v00
        indices[cursor++] = v10
        indices[cursor++] = v11
        indices[cursor++] = v00
        indices[cursor++] = v11
        indices[cursor++] = v01
      }
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3))
    geo.setIndex(new BufferAttribute(indices, 1))
    geo.computeVertexNormals()

    return { geometry: geo, zMid: (zMin + zMax) * 0.5 }
  }, [topValues, nx, ny, width, height])

  return (
    <mesh geometry={geometry} position={[0, 0, -zMid]}>
      <meshStandardMaterial color="#d47b3b" roughness={0.78} metalness={0.05} />
    </mesh>
  )
}

export function TerrainPreview3D({ topValues, nx, ny, width, height }: TerrainPreview3DProps) {
  const cameraDistance = Math.max(width, height) * 1.35

  return (
    <Canvas className="preview-3d-canvas" camera={{ position: [cameraDistance, -cameraDistance, cameraDistance], fov: 50 }}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[30, -20, 40]} intensity={0.8} />
      <TerrainMesh topValues={topValues} nx={nx} ny={ny} width={width} height={height} />
      <OrbitControls enablePan enableZoom enableRotate />
    </Canvas>
  )
}
