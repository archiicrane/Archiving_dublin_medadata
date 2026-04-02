import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import { thematicEdgeColors } from '../utils/colorSystem';

const THEMATIC_COLOR_SET = new Set(Object.values(thematicEdgeColors));

function toRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string') return `rgba(148,163,184,${alpha})`;
  const clean = hex.replace('#', '');
  const full = clean.length === 3
    ? clean.split('').map((c) => `${c}${c}`).join('')
    : clean;
  const value = Number.parseInt(full, 16);
  if (Number.isNaN(value)) return `rgba(148,163,184,${alpha})`;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

const GraphView3D = forwardRef(function GraphView3D({ graphData, selectedNodeId, onNodeClick }, ref) {
  const fgRef = useRef(null);
  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: 300, height: 300 });

  // react-force-graph mutates nodes/links for simulation state.
  // Keep an isolated copy so switching back to 2D doesn't receive mutated links.
  const fgData = useMemo(() => ({
    nodes: graphData.nodes.map((n) => ({ ...n })),
    links: graphData.links.map((l) => ({ ...l })),
  }), [graphData]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const resize = () => {
      const nextWidth = Math.max(320, Math.floor(el.clientWidth));
      const nextHeight = Math.max(320, Math.floor(el.clientHeight));
      setSize({ width: nextWidth, height: nextHeight });
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    window.addEventListener('resize', resize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, []);

  const neighborIds = useMemo(() => {
    const next = new Set();
    if (!selectedNodeId) return next;

    fgData.links.forEach((link) => {
      const src = typeof link.source === 'object' ? link.source.id : link.source;
      const tgt = typeof link.target === 'object' ? link.target.id : link.target;
      if (src === selectedNodeId || tgt === selectedNodeId) {
        next.add(src);
        next.add(tgt);
      }
    });

    return next;
  }, [fgData, selectedNodeId]);

  const selectedLinkSet = useMemo(() => {
    const next = new Set();
    if (!selectedNodeId) return next;

    fgData.links.forEach((link) => {
      const src = typeof link.source === 'object' ? link.source.id : link.source;
      const tgt = typeof link.target === 'object' ? link.target.id : link.target;
      if (src === selectedNodeId || tgt === selectedNodeId) {
        next.add(link.id);
      }
    });

    return next;
  }, [fgData, selectedNodeId]);

  // Mind-map physics: nodes that share a strong connection are pulled closer together.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    // --- Link force: shorter distance = more closely related ---
    const linkForce = fg.d3Force('link');
    if (linkForce) {
      linkForce
        .distance((link) => {
          // Exact visual matches are nearly identical drawings → cluster very tightly
          if (link.type === 'exact_visual_match') return 18;
          // Thematic links (water, vegetation, topography, building) → medium pull
          if (THEMATIC_COLOR_SET.has(link.color)) return 45;
          // Generic metadata relation → loose, gives room
          return 95;
        })
        .strength((link) => {
          if (link.type === 'exact_visual_match') return 0.9;
          if (THEMATIC_COLOR_SET.has(link.color)) return 0.55;
          return 0.15;
        });
    }

    // --- Charge force: repel unrelated nodes so clusters stay separated ---
    const chargeForce = fg.d3Force('charge');
    if (chargeForce) {
      chargeForce.strength(-90);
    }

    // Reheat so the new force parameters take effect
    fg.d3ReheatSimulation();
  }, [fgData]);

  const resetCamera = () => {
    if (fgRef.current) {
      fgRef.current.zoomToFit(450, 50);
    }
  };

  const focusSelected = () => {
    if (!fgRef.current || !selectedNodeId) return;
    const node = fgData.nodes.find((n) => n.id === selectedNodeId);
    if (!node) return;

    const distance = 120;
    const len = Math.hypot(node.x || 1, node.y || 1, node.z || 1);
    const k = distance / len;

    fgRef.current.cameraPosition(
      { x: (node.x || 0) * (1 + k), y: (node.y || 0) * (1 + k), z: (node.z || 0) * (1 + k) },
      { x: node.x || 0, y: node.y || 0, z: node.z || 0 },
      700
    );
  };

  useImperativeHandle(ref, () => ({
    resetCamera,
    focusSelected,
  }));

  return (
    <div ref={containerRef} className="graph-canvas graph-canvas-3d">
      <ForceGraph3D
        ref={fgRef}
        width={size.width}
        height={size.height}
        graphData={fgData}
        nodeResolution={6}
        linkResolution={3}
        backgroundColor="rgba(0,0,0,0)"
        nodeLabel={(node) => node.label}
        nodeAutoColorBy={null}
        nodeColor={(node) => {
          if (selectedNodeId && node.id === selectedNodeId) return '#fde047';
          if (neighborIds.has(node.id)) return node.color || '#6f98a6';
          return node.color || '#56717f';
        }}
        nodeVal={(node) => {
          if (selectedNodeId && node.id === selectedNodeId) return 8;
          if (neighborIds.has(node.id)) return 5;
          return 3.5;
        }}
        linkColor={(link) => {
          if (!selectedNodeId) return toRgba(link.color, 0.42);
          return selectedLinkSet.has(link.id)
            ? toRgba(link.color, 0.95)
            : toRgba(link.color, 0.14);
        }}
        linkWidth={(link) => (selectedLinkSet.has(link.id) ? 1.8 : 0.45)}
        linkOpacity={0.45}
        linkDirectionalParticles={(link) => (selectedLinkSet.has(link.id) ? 2 : 0)}
        linkDirectionalParticleSpeed={0.003}
        onNodeClick={(node) => onNodeClick(node.id)}
        onBackgroundClick={() => onNodeClick(null)}
        enableNodeDrag={true}
        cooldownTicks={300}
        d3AlphaDecay={0.018}
        d3VelocityDecay={0.38}
        onEngineStop={resetCamera}
      />
    </div>
  );
});

export default GraphView3D;
