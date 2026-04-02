import { useEffect, useMemo, useState } from 'react';
import FiltersPanel from './components/FiltersPanel';
import GraphView from './components/GraphView';
import ImageDetailModal from './components/ImageDetailModal';
import Legend from './components/Legend';
import MetadataPanel from './components/MetadataPanel';
import { createArchiveResolver } from './utils/archiveNaming';
import { extractBoardTitle, extractImageMetadata } from './utils/backendApi';
import { connectionLabels } from './utils/colorSystem';

const INITIAL_VISIBLE_NODES = 120;
const VISIBLE_NODE_CHUNK = 80;
const MAX_VISIBLE_NODES_2D = 300;
const MAX_VISIBLE_NODES_3D = 180;
const MAX_VISIBLE_EDGES_2D = 1200;
const MAX_VISIBLE_EDGES_3D = 520;
const FOCUS_NEIGHBOR_TARGET = 140;

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Could not load ${path}`);
  }
  return response.json();
}

export default function App() {
  const [metadata, setMetadata] = useState([]);
  const [graph, setGraph] = useState({ nodes: [], edges: [], connection_color_map: {} });
  const [regionConnections, setRegionConnections] = useState([]);

  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [modalImage, setModalImage] = useState(null);
  const [linkedRegionList, setLinkedRegionList] = useState([]);
  const [activeConnection, setActiveConnection] = useState(null);
  const [graphViewMode, setGraphViewMode] = useState('2d');
  const [graphZoomLevel, setGraphZoomLevel] = useState(1);
  const [visibleNodeBudget, setVisibleNodeBudget] = useState(INITIAL_VISIBLE_NODES);

  const archiveResolver = useMemo(() => createArchiveResolver(metadata), [metadata]);

  const drawingNameByInstanceId = useMemo(() => {
    const names = {};
    metadata.forEach((record) => {
      names[record.instance_id] = archiveResolver.getDisplayName(record);
    });
    return names;
  }, [metadata, archiveResolver]);

  const connectionTypes = useMemo(() => {
    const all = new Set();
    graph.edges.forEach((e) => e.connection_types.forEach((t) => all.add(t)));
    return Array.from(all);
  }, [graph]);

  const subjects = useMemo(() => {
    const all = new Set();
    metadata.forEach((m) => {
      const s = m?.dublin_core?.['dc:subject'];
      if (Array.isArray(s)) {
        s.forEach((v) => all.add(v));
      }
    });
    return Array.from(all).sort();
  }, [metadata]);

  const [filters, setFilters] = useState({
    minWeight: 0.5,
    connectionTypes: new Set(),
    subject: '',
    cluster: '',
    searchQuery: '',
  });

  useEffect(() => {
    async function loadData() {
      const [m, g, r, c] = await Promise.all([
        loadJson('/data/image_metadata.json'),
        loadJson('/data/image_graph.json'),
        loadJson('/data/region_connections.json'),
        loadJson('/data/clusters.json'),
      ]);
      setMetadata(m);
      setGraph(g);
      setRegionConnections(r);
      setFilters((prev) => ({ ...prev, connectionTypes: new Set(Object.keys(g.connection_color_map || {})) }));
    }

    loadData().catch((err) => {
      console.error(err);
      alert('Could not load data files. Run backend pipeline first.');
    });
  }, []);

  const selectedImage = useMemo(
    () => archiveResolver.resolveArchiveRecord(selectedNodeId) || null,
    [archiveResolver, selectedNodeId]
  );

  useEffect(() => {
    if (!selectedImage?.url || !selectedImage?.instance_id) return;

    const hasTitle = Boolean(
      selectedImage.canonical_board_title ||
      selectedImage.resolvedDisplayTitle ||
      (selectedImage.board_title && (selectedImage.board_title_confidence ?? 0) >= 0.4)
    );
    if (hasTitle) return;

    let active = true;
    extractBoardTitle({ image_url: selectedImage.url, use_openai: true })
      .then((payload) => {
        if (!active || !payload?.ok || !payload?.board_title) return;
        setMetadata((prev) =>
          prev.map((row) => {
            if (row.instance_id !== selectedImage.instance_id) return row;
            return {
              ...row,
              board_title: payload.board_title,
              board_title_confidence: payload.board_title_confidence ?? 0,
              resolvedDisplayTitle: payload.board_title,
              resolvedTitleSource: payload.source || 'backend_api',
            };
          })
        );
      })
      .catch(() => {
        // Keep existing fallback label if backend is unavailable.
      });

    extractImageMetadata({
      image_url: selectedImage.url,
      instance_id: selectedImage.instance_id,
      use_openai: true,
      force_refresh: false,
    }).catch(() => {
      // Metadata enrichment is optional for UI rendering.
    });

    return () => {
      active = false;
    };
  }, [selectedImage?.instance_id, selectedImage?.url]);

  const competitionByInstanceId = useMemo(() => {
    const map = {};
    metadata.forEach((record) => {
      map[record.instance_id] = archiveResolver.getCompetitionKey(record);
    });
    return map;
  }, [metadata, archiveResolver]);

  const competitionOptions = useMemo(() => {
    const counts = new Map();
    metadata.forEach((record) => {
      const key = archiveResolver.getCompetitionKey(record);
      const name = archiveResolver.getCompetitionName(record);
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { value: key, label: name, count: 1 });
      }
    });
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [metadata, archiveResolver]);

  const metadataById = useMemo(() => {
    const map = new Map();
    metadata.forEach((m) => map.set(m.instance_id, m));
    return map;
  }, [metadata]);

  const indexedLookup = useMemo(() => {
    const bySubject = new Map();
    const byCluster = new Map();
    const byProject = new Map();
    const byKeyword = new Map();

    metadata.forEach((row) => {
      const id = row.instance_id;
      const subjectsList = row?.dublin_core?.['dc:subject'];
      const subjectsNorm = Array.isArray(subjectsList)
        ? subjectsList
        : (subjectsList ? [subjectsList] : []);
      subjectsNorm.forEach((s) => {
        const k = String(s || '').toLowerCase().trim();
        if (!k) return;
        if (!bySubject.has(k)) bySubject.set(k, new Set());
        bySubject.get(k).add(id);
      });

      const cluster = String(competitionByInstanceId[id] || '').toLowerCase().trim();
      if (cluster) {
        if (!byCluster.has(cluster)) byCluster.set(cluster, new Set());
        byCluster.get(cluster).add(id);
      }

      const project = String(row.project_key || row.dublin_core?.['dc:relation'] || '').toLowerCase().trim();
      if (project) {
        if (!byProject.has(project)) byProject.set(project, new Set());
        byProject.get(project).add(id);
      }

      const kws = Array.isArray(row.extractedText?.keywords) ? row.extractedText.keywords : [];
      kws.slice(0, 80).forEach((kw) => {
        const k = String(kw || '').toLowerCase().trim();
        if (!k) return;
        if (!byKeyword.has(k)) byKeyword.set(k, new Set());
        byKeyword.get(k).add(id);
      });
    });

    return { bySubject, byCluster, byProject, byKeyword };
  }, [metadata, competitionByInstanceId]);

  const filteredEdges = useMemo(() => {
    return graph.edges.filter((edge) => {
      if (edge.weight < filters.minWeight) {
        return false;
      }

      const hasType = edge.connection_types.some((type) => filters.connectionTypes.has(type));
      if (!hasType) {
        return false;
      }

      if (filters.cluster) {
        const srcGroup = competitionByInstanceId[edge.source] || '';
        const tgtGroup = competitionByInstanceId[edge.target] || '';
        if (srcGroup !== filters.cluster && tgtGroup !== filters.cluster) {
          return false;
        }
      }

      if (filters.subject) {
        const src = metadataById.get(edge.source);
        const tgt = metadataById.get(edge.target);
        const srcSub = src?.dublin_core?.['dc:subject'] || [];
        const tgtSub = tgt?.dublin_core?.['dc:subject'] || [];
        if (!srcSub.includes(filters.subject) && !tgtSub.includes(filters.subject)) {
          return false;
        }
      }

      return true;
    });
  }, [graph, filters, competitionByInstanceId, metadataById]);

  const adjacencyByNode = useMemo(() => {
    const map = new Map();
    filteredEdges.forEach((e) => {
      if (!map.has(e.source)) map.set(e.source, []);
      if (!map.has(e.target)) map.set(e.target, []);
      map.get(e.source).push({ id: e.target, weight: e.weight });
      map.get(e.target).push({ id: e.source, weight: e.weight });
    });

    map.forEach((arr) => arr.sort((a, b) => b.weight - a.weight));
    return map;
  }, [filteredEdges]);

  const searchMatchedIds = useMemo(() => {
    const q = String(filters.searchQuery || '').toLowerCase().trim();
    if (!q) return null;

    const result = new Set();
    const { bySubject, byCluster, byProject, byKeyword } = indexedLookup;

    const addSet = (setLike) => {
      if (!setLike) return;
      setLike.forEach((id) => result.add(id));
    };

    addSet(bySubject.get(q));
    addSet(byCluster.get(q));
    addSet(byProject.get(q));
    addSet(byKeyword.get(q));

    metadata.forEach((row) => {
      const text = [
        row.title,
        row.displayTitle,
        row.resolvedDisplayTitle,
        row.board_title,
        row.canonical_board_title,
      ].filter(Boolean).join(' ').toLowerCase();
      if (text.includes(q)) result.add(row.instance_id);
    });

    return result;
  }, [filters.searchQuery, indexedLookup, metadata]);

  const activeNodeCap = graphViewMode === '3d' ? MAX_VISIBLE_NODES_3D : MAX_VISIBLE_NODES_2D;
  const activeEdgeCap = graphViewMode === '3d' ? MAX_VISIBLE_EDGES_3D : MAX_VISIBLE_EDGES_2D;
  const effectiveNodeBudget = Math.min(visibleNodeBudget, activeNodeCap);

  const visibleNodeIds = useMemo(() => {
    const inPool = new Set();
    filteredEdges.forEach((e) => {
      inPool.add(e.source);
      inPool.add(e.target);
    });

    if (searchMatchedIds) {
      for (const id of Array.from(inPool)) {
        if (!searchMatchedIds.has(id)) inPool.delete(id);
      }
    }

    if (selectedNodeId && inPool.has(selectedNodeId)) {
      const selected = new Set([selectedNodeId]);
      const queue = [selectedNodeId];
      while (queue.length && selected.size < effectiveNodeBudget) {
        const current = queue.shift();
        const neighbors = adjacencyByNode.get(current) || [];
        for (const n of neighbors) {
          if (!inPool.has(n.id) || selected.has(n.id)) continue;
          selected.add(n.id);
          queue.push(n.id);
          if (selected.size >= effectiveNodeBudget) break;
        }
      }
      return selected;
    }

    const degreeByNode = new Map();
    filteredEdges.forEach((e) => {
      if (!inPool.has(e.source) || !inPool.has(e.target)) return;
      degreeByNode.set(e.source, (degreeByNode.get(e.source) || 0) + e.weight);
      degreeByNode.set(e.target, (degreeByNode.get(e.target) || 0) + e.weight);
    });

    const ranked = Array.from(inPool).sort((a, b) => (degreeByNode.get(b) || 0) - (degreeByNode.get(a) || 0));
    return new Set(ranked.slice(0, effectiveNodeBudget));
  }, [filteredEdges, selectedNodeId, effectiveNodeBudget, searchMatchedIds, adjacencyByNode]);

  const visibleEdges = useMemo(() => {
    return filteredEdges
      .filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, activeEdgeCap);
  }, [filteredEdges, visibleNodeIds, activeEdgeCap]);

  const lodMode = useMemo(() => {
    if (graphViewMode !== '2d') return 'detail';
    if (selectedNodeId) return 'detail';
    return graphZoomLevel <= 0.62 ? 'cluster' : 'detail';
  }, [graphViewMode, selectedNodeId, graphZoomLevel]);

  const graphForView = useMemo(() => {
    if (lodMode !== 'cluster') return graph;

    const clusterNodes = new Map();
    const clusterEdges = new Map();

    const keyFor = (id) => competitionByInstanceId[id] || 'ungrouped';

    visibleNodeIds.forEach((id) => {
      const cluster = keyFor(id);
      const nodeId = `cluster::${cluster}`;
      if (!clusterNodes.has(nodeId)) {
        clusterNodes.set(nodeId, {
          id: nodeId,
          label: cluster,
          cluster,
          count: 0,
        });
      }
      clusterNodes.get(nodeId).count += 1;
    });

    visibleEdges.forEach((e) => {
      const sc = keyFor(e.source);
      const tc = keyFor(e.target);
      if (sc === tc) return;
      const a = `cluster::${sc}`;
      const b = `cluster::${tc}`;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!clusterEdges.has(key)) {
        clusterEdges.set(key, {
          source: a,
          target: b,
          weight: 0,
          connection_types: e.connection_types,
        });
      }
      clusterEdges.get(key).weight += e.weight;
    });

    return {
      ...graph,
      nodes: Array.from(clusterNodes.values()),
      edges: Array.from(clusterEdges.values()),
    };
  }, [lodMode, graph, visibleNodeIds, visibleEdges, competitionByInstanceId]);

  const edgesForView = useMemo(() => {
    if (lodMode === 'cluster') return graphForView.edges;
    return visibleEdges;
  }, [lodMode, graphForView.edges, visibleEdges]);

  const nodeLabelsForView = useMemo(() => {
    if (lodMode !== 'cluster') return drawingNameByInstanceId;
    const map = { ...drawingNameByInstanceId };
    graphForView.nodes.forEach((n) => {
      map[n.id] = `${n.label} (${n.count})`;
    });
    return map;
  }, [lodMode, drawingNameByInstanceId, graphForView.nodes]);

  const progressiveHint = useMemo(() => {
    if (lodMode === 'cluster') {
      return 'Showing cluster overview. Click a cluster to expand into detailed nodes.';
    }
    if (selectedNodeId) {
      return 'Focus mode: showing closest connections around the selected drawing.';
    }
    return `Showing ${visibleNodeIds.size} nodes from ${metadata.length}. Zoom out to load more.`;
  }, [lodMode, selectedNodeId, visibleNodeIds.size, metadata.length]);

  const openNode = (nodeId) => {
    if (typeof nodeId === 'string' && nodeId.startsWith('cluster::')) {
      const clusterKey = nodeId.replace('cluster::', '');
      setFilters((prev) => ({ ...prev, cluster: clusterKey }));
      setVisibleNodeBudget((prev) => Math.max(prev, FOCUS_NEIGHBOR_TARGET));
      return;
    }

    setSelectedNodeId(nodeId);
    setActiveConnection(null);
    setVisibleNodeBudget((prev) => Math.max(prev, FOCUS_NEIGHBOR_TARGET));
    const image = archiveResolver.resolveArchiveRecord(nodeId);
    if (image) {
      setModalImage(image);
      setLinkedRegionList([]);
    }
  };

  const handleZoomLevelChange = (zoom) => {
    setGraphZoomLevel(zoom);
    if (zoom <= 0.7) {
      setVisibleNodeBudget((prev) => Math.min(prev + VISIBLE_NODE_CHUNK, MAX_VISIBLE_NODES_2D));
    }
  };

  const navigateHotspot = (regionConnection, targetInstanceId) => {
    setActiveConnection(regionConnection);

    const related = regionConnections.filter(
      (rc) =>
        rc.id === regionConnection.id ||
        rc.source_instance_id === targetInstanceId ||
        rc.target_instance_id === targetInstanceId
    );

    if (related.length > 1) {
      setLinkedRegionList(related);
    }

    const image = archiveResolver.resolveArchiveRecord(targetInstanceId);
    if (image) {
      setModalImage(image);
      setSelectedNodeId(targetInstanceId);
    }
  };

  const closeModal = () => {
    setModalImage(null);
    setActiveConnection(null);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>Interconnected Drawing Archive</h1>
        <p>Graph exploration with region-to-region visual links and Dublin Core metadata grounding.</p>
      </header>

      <section className="workspace">
        <aside className="left-column">
          <FiltersPanel
            filters={filters}
            setFilters={setFilters}
            subjects={subjects}
            clusters={competitionOptions}
            connectionTypes={connectionTypes}
          />
          <Legend />
          <MetadataPanel
            image={selectedImage}
            drawingDisplayName={selectedImage ? archiveResolver.getDisplayName(selectedImage) : ''}
            archiveSecondaryLine={selectedImage ? archiveResolver.getSecondaryLine(selectedImage) : null}
          />
        </aside>

        <main className="graph-column">
          <GraphView
            graph={graphForView}
            filteredEdges={edgesForView}
            onNodeClick={openNode}
            selectedNodeId={selectedNodeId}
            nodeLabelById={nodeLabelsForView}
            viewMode={graphViewMode}
            setViewMode={setGraphViewMode}
            onZoomLevelChange={handleZoomLevelChange}
            progressiveHint={progressiveHint}
          />
        </main>
      </section>

      {linkedRegionList.length > 1 && (
        <div className="mini-cluster">
          <h3>Related Region Cluster</h3>
          <div className="cluster-list">
            {linkedRegionList.slice(0, 10).map((rc) => (
              <button
                type="button"
                key={rc.id + rc.source_instance_id + rc.target_instance_id}
                onClick={() => openNode(rc.target_instance_id)}
              >
                {archiveResolver.getDisplayName(rc.source_instance_id)} -&gt; {archiveResolver.getDisplayName(rc.target_instance_id)} ({connectionLabels[rc.connection_type] || rc.connection_type})
              </button>
            ))}
          </div>
        </div>
      )}

      <ImageDetailModal
        image={modalImage}
        regionConnections={regionConnections}
        onNavigateToLinked={navigateHotspot}
        activeConnection={activeConnection}
        getDrawingDisplayName={archiveResolver.getDisplayName}
        getArchiveRecord={archiveResolver.resolveArchiveRecord}
        getArchiveSecondaryLine={archiveResolver.getSecondaryLine}
        onClose={closeModal}
        onBackToGraph={closeModal}
      />
    </div>
  );
}
