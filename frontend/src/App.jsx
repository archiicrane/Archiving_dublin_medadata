import { useEffect, useMemo, useRef, useState } from 'react';
import FiltersPanel from './components/FiltersPanel';
import GraphView from './components/GraphView';
import ImageDetailModal from './components/ImageDetailModal';
import Legend from './components/Legend';
import MetadataPanel from './components/MetadataPanel';
import ChatWidget from './components/ChatWidget';
import { createArchiveResolver } from './utils/archiveNaming';

import { connectionLabels, getCompetitionColor } from './utils/colorSystem';

const INITIAL_VISIBLE_NODES = 1200;
const VISIBLE_NODE_CHUNK = 400;
const MAX_VISIBLE_NODES_2D = 6000;
const MAX_VISIBLE_NODES_3D = 6000;
const MAX_VISIBLE_EDGES_2D = 6000;
const MAX_VISIBLE_EDGES_3D = 18000;
const FOCUS_NEIGHBOR_TARGET = 600;
const MAX_DETAIL_NODES_2D = 1800;
const MAX_SEARCH_MATCH_IDS = 1400;

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
  const [graphZoomLevel, setGraphZoomLevel] = useState(0.28);
  const [visibleNodeBudget, setVisibleNodeBudget] = useState(INITIAL_VISIBLE_NODES);
  const zoomExpandLatchRef = useRef(false);

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

  const resetFilters = () => {
    setFilters({
      minWeight: 0.5,
      connectionTypes: new Set(Object.keys(graph.connection_color_map || {})),
      subject: '',
      cluster: '',
      searchQuery: '',
    });
  };

  useEffect(() => {
    async function loadData() {
      const [m, g, r, c] = await Promise.all([
        loadJson('/data/image_metadata.json'),
        loadJson('/data/image_graph.json'),
        loadJson('/data/region_connections.json'),
        loadJson('/data/clusters.json'),
      ]);

      // Merge pre-generated enriched metadata if available (produced by scripts/enrich_metadata.py).
      // Never calls OpenAI at runtime — all enrichment is done offline.
      let merged = m;
      try {
        const enriched = await loadJson('/data/enriched_metadata.json');
        if (Array.isArray(enriched) && enriched.length > 0) {
          const enrichedById = {};
          enriched.forEach((rec) => {
            if (rec?.instance_id) enrichedById[rec.instance_id] = rec;
          });
          merged = m.map((rec) => {
            const e = enrichedById[rec.instance_id];
            if (!e) return rec;
            return {
              ...rec,
              ...e,
              dublin_core: {
                ...(rec.dublin_core || {}),
                ...(e.dublin_core || {}),
              },
            };
          });
        }
      } catch {
        // enriched_metadata.json doesn't exist yet — run scripts/enrich_metadata.py to generate it.
      }

      setMetadata(merged);
      setGraph(g);
      setRegionConnections(r);
      setVisibleNodeBudget(Math.max(INITIAL_VISIBLE_NODES, m.length));
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

  const nodeColorById = useMemo(() => {
    const map = {};
    metadata.forEach((record) => {
      const key = competitionByInstanceId[record.instance_id] || 'ungrouped';
      map[record.instance_id] = getCompetitionColor(key);
    });
    return map;
  }, [metadata, competitionByInstanceId]);

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

  const searchableRecords = useMemo(() => {
    return metadata.map((row) => {
      const title = [
        row.resolvedDisplayTitle,
        row.canonical_board_title,
        row.board_title,
        row.title,
        row.displayTitle,
      ].filter(Boolean).join(' ').toLowerCase();

      const subject = Array.isArray(row?.dublin_core?.['dc:subject'])
        ? row.dublin_core['dc:subject'].join(' ').toLowerCase()
        : String(row?.dublin_core?.['dc:subject'] || '').toLowerCase();

      const keywords = Array.isArray(row?.extractedText?.keywords)
        ? row.extractedText.keywords.join(' ').toLowerCase()
        : '';

      const ocr = String(row.ocr_text || '').slice(0, 4000).toLowerCase();
      const project = String(row.project_key || row?.dublin_core?.['dc:relation'] || '').toLowerCase();

      return {
        row,
        title,
        subject,
        keywords,
        ocr,
        project,
      };
    });
  }, [metadata]);

  const searchDrawings = (query, terms = []) => {
    const tokenSet = new Set();
    String(query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2)
      .forEach((t) => tokenSet.add(t));

    (Array.isArray(terms) ? terms : [])
      .map((t) => String(t).toLowerCase())
      .flatMap((t) => t.split(/[^a-z0-9]+/))
      .filter((t) => t.length >= 2)
      .forEach((t) => tokenSet.add(t));

    const tokens = Array.from(tokenSet).slice(0, 16);
    if (!tokens.length) return [];

    const scored = [];
    for (const item of searchableRecords) {
      let score = 0;
      for (const token of tokens) {
        if (item.title.includes(token)) score += 8;
        if (item.subject.includes(token)) score += 6;
        if (item.keywords.includes(token)) score += 7;
        if (item.project.includes(token)) score += 4;
        if (item.ocr.includes(token)) score += 2;
      }

      if (score > 0) {
        scored.push({
          score,
          instance_id: item.row.instance_id,
          url: item.row.url,
          title:
            item.row.resolvedDisplayTitle ||
            item.row.canonical_board_title ||
            item.row.board_title ||
            item.row.title ||
            item.row.instance_id,
          secondary: archiveResolver.getSecondaryLine(item.row),
        });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 120);
  };

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
      for (const id of setLike) {
        result.add(id);
        if (result.size >= MAX_SEARCH_MATCH_IDS) break;
      }
    };

    addSet(bySubject.get(q));
    addSet(byCluster.get(q));
    addSet(byProject.get(q));
    addSet(byKeyword.get(q));

    metadata.forEach((row) => {
      if (result.size >= MAX_SEARCH_MATCH_IDS) return;
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
  const effectiveNodeBudget = Math.min(
    visibleNodeBudget,
    activeNodeCap,
    graphViewMode === '2d' && graphZoomLevel > 0.35 ? MAX_DETAIL_NODES_2D : activeNodeCap
  );

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

  const visibleClusterCount = useMemo(() => {
    const set = new Set();
    visibleNodeIds.forEach((id) => {
      set.add(competitionByInstanceId[id] || 'ungrouped');
    });
    return set.size;
  }, [visibleNodeIds, competitionByInstanceId]);

  const lodMode = useMemo(() => {
    if (graphViewMode !== '2d') return 'detail';
    if (selectedNodeId) return 'detail';
    if (visibleClusterCount < 3) return 'detail';
    return graphZoomLevel <= 0.35 ? 'cluster' : 'detail';
  }, [graphViewMode, selectedNodeId, graphZoomLevel, visibleClusterCount]);

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
    return `Showing ${visibleNodeIds.size} nodes from ${metadata.length} after filters.`;
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
    // Expand budget only once per zoom-in gesture band to avoid layout thrash.
    if (zoom <= 0.55 && !zoomExpandLatchRef.current) {
      setVisibleNodeBudget((prev) => Math.min(prev + VISIBLE_NODE_CHUNK, MAX_VISIBLE_NODES_2D));
      zoomExpandLatchRef.current = true;
    }

    if (zoom > 0.7) {
      zoomExpandLatchRef.current = false;
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

  const fallbackGraphConnections = useMemo(() => {
    const currentId = modalImage?.instance_id;
    if (!currentId) return [];

    const edgeLinks = graph.edges
      .filter((e) => e.source === currentId || e.target === currentId)
      .map((e) => {
        const targetId = e.source === currentId ? e.target : e.source;
        return {
          targetId,
          weight: Number(e.weight || 0),
          type: e.connection_types?.[0] || 'metadata_relation',
          source: 'graph',
          label: connectionLabels[e.connection_types?.[0]] || connectionLabels.metadata_relation || 'Graph relation',
        };
      })
      .sort((a, b) => b.weight - a.weight);

    const current = metadataById.get(currentId);
    if (!current) {
      return edgeLinks.slice(0, 12);
    }

    const currentSubjects = new Set(Array.isArray(current?.dublin_core?.['dc:subject'])
      ? current.dublin_core['dc:subject'].map((v) => String(v).toLowerCase().trim()).filter(Boolean)
      : []);
    const currentVisual = new Set(Array.isArray(current?.archdrw?.hasVisualElement)
      ? current.archdrw.hasVisualElement.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
      : []);
    const currentTypes = new Set(Array.isArray(current?.archdrw?.drawingType)
      ? current.archdrw.drawingType.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
      : []);
    const currentProgram = new Set(Array.isArray(current?.archdrw?.buildingProgram)
      ? current.archdrw.buildingProgram.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
      : []);

    const metadataLinks = [];
    metadata.forEach((cand) => {
      if (!cand?.instance_id || cand.instance_id === currentId) return;

      const candSubjects = new Set(Array.isArray(cand?.dublin_core?.['dc:subject'])
        ? cand.dublin_core['dc:subject'].map((v) => String(v).toLowerCase().trim()).filter(Boolean)
        : []);
      const candVisual = new Set(Array.isArray(cand?.archdrw?.hasVisualElement)
        ? cand.archdrw.hasVisualElement.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
        : []);
      const candTypes = new Set(Array.isArray(cand?.archdrw?.drawingType)
        ? cand.archdrw.drawingType.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
        : []);
      const candProgram = new Set(Array.isArray(cand?.archdrw?.buildingProgram)
        ? cand.archdrw.buildingProgram.map((v) => String(v).toLowerCase().trim()).filter(Boolean)
        : []);

      const sharedSubjects = [...currentSubjects].filter((v) => candSubjects.has(v));
      const sharedVisual = [...currentVisual].filter((v) => candVisual.has(v));
      const sharedTypes = [...currentTypes].filter((v) => candTypes.has(v));
      const sharedProgram = [...currentProgram].filter((v) => candProgram.has(v));

      const score = (sharedSubjects.length * 1.8)
        + (sharedVisual.length * 2.2)
        + (sharedTypes.length * 1.5)
        + (sharedProgram.length * 1.4);

      if (score <= 0) return;

      const reasons = [
        ...sharedVisual.slice(0, 2).map((v) => `visual:${v}`),
        ...sharedTypes.slice(0, 1).map((v) => `type:${v}`),
        ...sharedProgram.slice(0, 1).map((v) => `program:${v}`),
        ...sharedSubjects.slice(0, 2).map((v) => `subject:${v}`),
      ];

      metadataLinks.push({
        targetId: cand.instance_id,
        weight: Number(score.toFixed(2)),
        type: 'metadata_relation',
        source: 'metadata',
        label: 'Metadata similarity',
        reasons,
      });
    });

    metadataLinks.sort((a, b) => b.weight - a.weight);

    const mergedByTarget = new Map();
    [...edgeLinks, ...metadataLinks].forEach((link) => {
      const existing = mergedByTarget.get(link.targetId);
      if (!existing || link.weight > existing.weight) {
        mergedByTarget.set(link.targetId, link);
      }
    });

    return Array.from(mergedByTarget.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12);
  }, [graph.edges, metadata, metadataById, modalImage?.instance_id]);

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
            totalDrawings={metadata.length}
            visibleDrawings={graphForView?.nodes?.length || 0}
            visibleConnections={edgesForView.length}
            onResetFilters={resetFilters}
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
            nodeColorById={nodeColorById}
            metadataById={metadataById}
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
        relatedGraphConnections={fallbackGraphConnections}
        onNavigateToLinked={navigateHotspot}
        onOpenDrawing={openNode}
        activeConnection={activeConnection}
        getDrawingDisplayName={archiveResolver.getDisplayName}
        getArchiveRecord={archiveResolver.resolveArchiveRecord}
        getArchiveSecondaryLine={archiveResolver.getSecondaryLine}
        onClose={closeModal}
        onBackToGraph={closeModal}
      />

      <ChatWidget
        selectedImage={selectedImage}
        archiveSecondaryLine={selectedImage ? archiveResolver.getSecondaryLine(selectedImage) : null}
        totalDrawings={metadata.length}
        onOpenDrawing={openNode}
        searchDrawings={searchDrawings}
      />
    </div>
  );
}




