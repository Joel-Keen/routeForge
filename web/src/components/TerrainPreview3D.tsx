import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three'

type TerrainPreview3DProps = {
  topValues: number[]
  nx: number
  ny: number
  width: number
  height: number
}

function TerrainMesh({ topValues, nx, ny, width, height }: TerrainPreview3DProps) {
  const { geometry, zMid } = useMemo(() => {
    const topCount = nx * ny
    const totalVertexCount = topCount * 2
    const positions = new Float32Array(totalVertexCount * 3)
    let zMax = Number.NEGATIVE_INFINITY

    for (let iy = 0; iy < ny; iy += 1) {
      for (let ix = 0; ix < nx; ix += 1) {
        const idx = iy * nx + ix
        const x = (ix / Math.max(1, nx - 1)) * width - width * 0.5
        const y = (iy / Math.max(1, ny - 1)) * height - height * 0.5
        const z = topValues[idx]

        const topOffset = idx * 3
        positions[topOffset] = x
        positions[topOffset + 1] = y
        positions[topOffset + 2] = z

        const bottomOffset = (topCount + idx) * 3
        positions[bottomOffset] = x
        positions[bottomOffset + 1] = y
        positions[bottomOffset + 2] = 0

        if (z > zMax) zMax = z
      }
    }

    const topCellCount = (nx - 1) * (ny - 1)
    const sideQuadCount = (nx - 1) * 2 + (ny - 1) * 2
    const indexCount = topCellCount * 6 + topCellCount * 6 + sideQuadCount * 6
    const IndexArray = totalVertexCount > 65535 ? Uint32Array : Uint16Array
    const indices = new IndexArray(indexCount)
    let cursor = 0

    const topIndex = (ix: number, iy: number) => iy * nx + ix
    const bottomIndex = (ix: number, iy: number) => topCount + iy * nx + ix

    for (let iy = 0; iy < ny - 1; iy += 1) {
      for (let ix = 0; ix < nx - 1; ix += 1) {
        const t00 = topIndex(ix, iy)
        const t10 = topIndex(ix + 1, iy)
        const t11 = topIndex(ix + 1, iy + 1)
        const t01 = topIndex(ix, iy + 1)

        // Top surface
        indices[cursor++] = t00
        indices[cursor++] = t10
        indices[cursor++] = t11
        indices[cursor++] = t00
        indices[cursor++] = t11
        indices[cursor++] = t01

        const b00 = bottomIndex(ix, iy)
        const b10 = bottomIndex(ix + 1, iy)
        const b11 = bottomIndex(ix + 1, iy + 1)
        const b01 = bottomIndex(ix, iy + 1)

        // Bottom face, winding reversed so normals point downward.
        indices[cursor++] = b00
        indices[cursor++] = b11
        indices[cursor++] = b10
        indices[cursor++] = b00
        indices[cursor++] = b01
        indices[cursor++] = b11
      }
    }

    for (let ix = 0; ix < nx - 1; ix += 1) {
      const t0 = topIndex(ix, 0)
      const t1 = topIndex(ix + 1, 0)
      const b0 = bottomIndex(ix, 0)
      const b1 = bottomIndex(ix + 1, 0)
      indices[cursor++] = b0
      indices[cursor++] = b1
      indices[cursor++] = t1
      indices[cursor++] = b0
      indices[cursor++] = t1
      indices[cursor++] = t0
    }

    for (let ix = 0; ix < nx - 1; ix += 1) {
      const t0 = topIndex(ix, ny - 1)
      const t1 = topIndex(ix + 1, ny - 1)
      const b0 = bottomIndex(ix, ny - 1)
      const b1 = bottomIndex(ix + 1, ny - 1)
      indices[cursor++] = b0
      indices[cursor++] = t1
      indices[cursor++] = b1
      indices[cursor++] = b0
      indices[cursor++] = t0
      indices[cursor++] = t1
    }

    for (let iy = 0; iy < ny - 1; iy += 1) {
      const t0 = topIndex(0, iy)
      const t1 = topIndex(0, iy + 1)
      const b0 = bottomIndex(0, iy)
      const b1 = bottomIndex(0, iy + 1)
      indices[cursor++] = b0
      indices[cursor++] = t0
      indices[cursor++] = t1
      indices[cursor++] = b0
      indices[cursor++] = t1
      indices[cursor++] = b1
    }

    for (let iy = 0; iy < ny - 1; iy += 1) {
      const t0 = topIndex(nx - 1, iy)
      const t1 = topIndex(nx - 1, iy + 1)
      const b0 = bottomIndex(nx - 1, iy)
      const b1 = bottomIndex(nx - 1, iy + 1)
      indices[cursor++] = b0
      indices[cursor++] = t1
      indices[cursor++] = t0
      indices[cursor++] = b0
      indices[cursor++] = b1
      indices[cursor++] = t1
    }

    const geo = new BufferGeometry()
    geo.setAttribute('position', new BufferAttribute(positions, 3))
    geo.setIndex(new BufferAttribute(indices, 1))
    geo.computeVertexNormals()

    return { geometry: geo, zMid: zMax * 0.5 }
  }, [topValues, nx, ny, width, height])

  return (
    <mesh geometry={geometry} position={[0, 0, -zMid]}>
      <meshStandardMaterial color="#d47b3b" roughness={0.78} metalness={0.05} side={DoubleSide} />
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
