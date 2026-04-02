import { useEffect, useRef } from 'react';
import cytoscape from 'cytoscape';

const LABEL_ZOOM_THRESHOLD = 2.0;

export default function GraphView2D({ graphData, onNodeClick, selectedNodeId, onZoomLevelChange }) {
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const onClickRef = useRef(onNodeClick);
  const onZoomRef = useRef(onZoomLevelChange);
  const rafRef = useRef(null);

  useEffect(() => {
    onZoomRef.current = onZoomLevelChange;
  }, [onZoomLevelChange]);

  useEffect(() => {
    onClickRef.current = onNodeClick;
  }, [onNodeClick]);

  useEffect(() => {
    if (!containerRef.current || !graphData) return;

    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const cyNodes = graphData.nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label,
        cluster: n.cluster,
      },
    }));

    const cyEdges = graphData.links
      .map((e) => {
        const sourceId = typeof e.source === 'object' ? e.source?.id : e.source;
        const targetId = typeof e.target === 'object' ? e.target?.id : e.target;

        if (!sourceId || !targetId) {
          return null;
        }

        return {
          data: {
            id: e.id,
            source: sourceId,
            target: targetId,
            weight: e.weight,
            color: e.color,
          },
        };
      })
      .filter(Boolean);

    const nc = cyNodes.length || 1;
    const repulsion = Math.max(4096, nc * nc * 4);
    const edgeLen = Math.min(180, Math.max(55, 800 / Math.sqrt(nc)));

    const cy = cytoscape({
      container: containerRef.current,
      elements: [...cyNodes, ...cyEdges],
      style: [
        {
          selector: 'node',
          style: {
            'background-color': '#56717f',
            width: 14,
            height: 14,
            label: '',
          },
        },
        {
          selector: 'node.label-visible',
          style: {
            label: 'data(label)',
            'font-family': 'Space Grotesk, sans-serif',
            'font-size': 8,
            color: '#e2e8f0',
            'text-background-color': 'rgba(3,11,24,0.72)',
            'text-background-opacity': 1,
            'text-background-padding': '2px',
            'text-wrap': 'ellipsis',
            'text-max-width': 88,
            'text-valign': 'bottom',
            'text-margin-y': 4,
          },
        },
        {
          selector: 'node.hovered',
          style: {
            label: 'data(label)',
            'font-family': 'Space Grotesk, sans-serif',
            'font-size': 10,
            color: '#ffffff',
            'text-background-color': 'rgba(3,11,24,0.88)',
            'text-background-opacity': 1,
            'text-background-padding': '3px',
            'text-wrap': 'ellipsis',
            'text-max-width': 110,
            'text-valign': 'bottom',
            'text-margin-y': 5,
            'background-color': '#6f98a6',
            width: 20,
            height: 20,
            'z-index': 5,
          },
        },
        {
          selector: 'node:selected',
          style: {
            label: 'data(label)',
            'font-family': 'Space Grotesk, sans-serif',
            'font-size': 11,
            color: '#ffffff',
            'text-background-color': 'rgba(3,11,24,0.9)',
            'text-background-opacity': 1,
            'text-background-padding': '3px',
            'text-wrap': 'ellipsis',
            'text-max-width': 120,
            'text-valign': 'bottom',
            'text-margin-y': 5,
            'background-color': '#b79e74',
            width: 22,
            height: 22,
            'border-width': 2,
            'border-color': '#d2be9a',
            'z-index': 10,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 'mapData(weight, 0, 1, 0.4, 3)',
            'line-color': 'data(color)',
            opacity: 0.4,
            'curve-style': 'haystack',
          },
        },
      ],
      layout: {
        name: 'cose',
        animate: false,
        randomize: true,
        idealEdgeLength: edgeLen,
        nodeRepulsion: repulsion,
        nodeOverlap: 32,
        gravity: 0.2,
        numIter: 1000,
        coolingFactor: 0.95,
        componentSpacing: 140,
      },
    });

    cy.on('mouseover', 'node', (evt) => evt.target.addClass('hovered'));
    cy.on('mouseout', 'node', (evt) => evt.target.removeClass('hovered'));

    const syncLabels = () => {
      if (cy.zoom() >= LABEL_ZOOM_THRESHOLD) {
        cy.nodes().addClass('label-visible');
      } else {
        cy.nodes().removeClass('label-visible');
      }
    };

    const notifyZoom = () => {
      if (!onZoomRef.current) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        onZoomRef.current(cy.zoom());
      });
    };

    cy.on('zoom', () => {
      syncLabels();
      notifyZoom();
    });
    syncLabels();
    notifyZoom();

    cy.on('tap', 'node', (evt) => onClickRef.current(evt.target.id()));

    cyRef.current = cy;
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      cy.destroy();
      cyRef.current = null;
    };
  }, [graphData]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().unselect();
    if (selectedNodeId) {
      const node = cy.getElementById(selectedNodeId);
      if (node.length) node.select();
    }
  }, [selectedNodeId]);

  return <div ref={containerRef} className="graph-canvas" />;
}
