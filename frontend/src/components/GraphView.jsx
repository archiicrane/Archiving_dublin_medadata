import { useMemo, useRef } from 'react';
import { connectionColors } from '../utils/colorSystem';
import GraphView2D from './GraphView2D';
import GraphView3D from './GraphView3D';

// Keep 2D responsive while allowing 3D to show the full node set.
const MAX_EDGES_2D = 12000;
const MAX_EDGES_3D = 18000;

function buildEdgeColor(edge) {
  const firstType = edge.connection_types?.[0];
  return connectionColors[firstType] || '#9ca3af';
}

export default function GraphView({
  graph,
  filteredEdges,
  onNodeClick,
  selectedNodeId,
  nodeLabelById = {},
  viewMode,
  setViewMode,
  onZoomLevelChange,
  progressiveHint,
}) {
  const graph3dRef = useRef(null);

  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };

    const edgeCap = viewMode === '3d' ? MAX_EDGES_3D : MAX_EDGES_2D;

    const cappedEdges = [...filteredEdges]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, edgeCap);

    const nodeIds = new Set();
    cappedEdges.forEach((e) => {
      nodeIds.add(e.source);
      nodeIds.add(e.target);
    });

    const baseNodes = viewMode === '3d'
      ? graph.nodes
      : (nodeIds.size > 0 ? graph.nodes.filter((n) => nodeIds.has(n.id)) : graph.nodes);

    const nodes = baseNodes
      .map((n) => ({
        id: n.id,
        label: nodeLabelById[n.id] || n.label || n.id,
        cluster: n.cluster,
      }));

    const links = cappedEdges.map((e, idx) => ({
      id: `e_${idx}`,
      source: e.source,
      target: e.target,
      weight: e.weight,
      type: e.connection_types?.[0] || 'unknown',
      color: buildEdgeColor(e),
    }));

    return { nodes, links };
  }, [graph, filteredEdges, nodeLabelById, viewMode]);

  const handleBackgroundClick = (nodeId) => {
    if (!nodeId) return;
    onNodeClick(nodeId);
  };

  return (
    <div className="graph-view-shell">
      <div className="graph-view-toolbar">
        <div className="view-toggle" role="group" aria-label="Graph view mode">
          <button
            type="button"
            className={viewMode === '2d' ? 'view-toggle-btn active' : 'view-toggle-btn'}
            onClick={() => setViewMode('2d')}
          >
            2D
          </button>
          <button
            type="button"
            className={viewMode === '3d' ? 'view-toggle-btn active' : 'view-toggle-btn'}
            onClick={() => setViewMode('3d')}
          >
            3D
          </button>
        </div>

        {viewMode === '3d' && (
          <div className="graph-view-actions">
            <button type="button" className="view-action-btn" onClick={() => graph3dRef.current?.resetCamera()}>
              Reset Camera
            </button>
            <button
              type="button"
              className="view-action-btn"
              onClick={() => graph3dRef.current?.focusSelected()}
              disabled={!selectedNodeId}
            >
              Focus Selected
            </button>
          </div>
        )}
      </div>

      {progressiveHint && <p className="graph-progressive-hint subtle">{progressiveHint}</p>}

      {viewMode === '2d' ? (
        <GraphView2D
          graphData={graphData}
          onNodeClick={handleBackgroundClick}
          selectedNodeId={selectedNodeId}
          onZoomLevelChange={onZoomLevelChange}
        />
      ) : (
        <GraphView3D
          ref={graph3dRef}
          graphData={graphData}
          selectedNodeId={selectedNodeId}
          onNodeClick={handleBackgroundClick}
        />
      )}
    </div>
  );
}
