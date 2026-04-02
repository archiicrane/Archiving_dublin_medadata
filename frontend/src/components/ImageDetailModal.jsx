import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { connectionColors } from '../utils/colorSystem';
import {
  getConnectionLabel,
  getMatchSource,
  getEvidenceTags,
  getConfidenceLabel,
} from '../utils/connectionExplainer';

const MAX_VISIBLE_REGIONS = 18;

function normalizeRegion(region, naturalW, naturalH) {
  if (!region) return null;
  const x = Number(region.x);
  const y = Number(region.y);
  const w = Number(region.width ?? region.w);
  const h = Number(region.height ?? region.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;

  const looksNormalized =
    x >= 0 && y >= 0 && w > 0 && h > 0 && x <= 1.2 && y <= 1.2 && w <= 1.2 && h <= 1.2;

  const sx = looksNormalized ? x * naturalW : x;
  const sy = looksNormalized ? y * naturalH : y;
  const sw = looksNormalized ? w * naturalW : w;
  const sh = looksNormalized ? h * naturalH : h;

  const nx = Math.max(0, Math.min(naturalW - 1, sx));
  const ny = Math.max(0, Math.min(naturalH - 1, sy));
  const nw = Math.max(1, Math.min(naturalW - nx, sw));
  const nh = Math.max(1, Math.min(naturalH - ny, sh));

  if (nw < 2 || nh < 2) return null;
  return { x: nx, y: ny, width: nw, height: nh };
}

function expandRegion(region, naturalW, naturalH, multiplier = 0.42) {
  const base = normalizeRegion(region, naturalW, naturalH);
  if (!base) return null;

  const padX = Math.max(18, base.width * multiplier);
  const padY = Math.max(18, base.height * multiplier);

  const x = Math.max(0, base.x - padX);
  const y = Math.max(0, base.y - padY);
  const width = Math.min(naturalW - x, base.width + padX * 2);
  const height = Math.min(naturalH - y, base.height + padY * 2);

  return { x, y, width, height };
}

function isWeakRegion(rc, currentInstanceId) {
  const isSource = rc.source_instance_id === currentInstanceId;
  const m = isSource ? rc.source_region_metrics : rc.target_region_metrics;
  const blank = Number(m?.blankness || 0);
  const contrast = Number(m?.contrast || 0);
  const edges = Number(m?.edge_density || 0);
  return Boolean(rc.weak_region) || (blank >= 0.82 && contrast <= 0.08 && edges <= 0.03);
}

function localEvidenceExplanation(rc, currentInstanceId) {
  const isSource = rc.source_instance_id === currentInstanceId;
  const m = isSource ? rc.source_region_metrics || {} : rc.target_region_metrics || {};
  const evidence = new Set(rc.evidence_kinds || []);
  const blank = Number(m.blankness || 0);
  const lines = Number(m.line_density || 0);
  const contrast = Number(m.contrast || 0);
  const keys = Number(m.keypoint_count || 0);

  if (blank >= 0.82 && contrast <= 0.08) {
    return 'Low-detail region match.';
  }
  if (evidence.has('text')) {
    return 'Text + structure match.';
  }
  if (lines >= 0.18) {
    return 'Linework + grid similarity.';
  }
  if (keys >= 20) {
    return 'Corner + geometry match.';
  }
  return rc.explanation || 'Local visual pattern match.';
}

function EvidenceTags({ type, evidenceKinds }) {
  const tags = getEvidenceTags(type, evidenceKinds);
  if (!tags.length) return null;
  return (
    <div className="evidence-tags">
      {tags.map((t) => (
        <span key={t.kind} className={`evidence-tag ${t.cls}`}>{t.label}</span>
      ))}
    </div>
  );
}

function OverlayBox({ region, naturalW, naturalH, className, color, title }) {
  const normalized = normalizeRegion(region, naturalW, naturalH);
  if (!normalized) return null;

  const left = (normalized.x / naturalW) * 100;
  const top = (normalized.y / naturalH) * 100;
  const width = (normalized.width / naturalW) * 100;
  const height = (normalized.height / naturalH) * 100;

  return (
    <div
      className={className}
      title={title}
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
        '--overlay-color': color,
      }}
    />
  );
}

function RegionCropPreview({ imageUrl, region, label, textBias = false }) {
  const [dims, setDims] = useState({ w: 0, h: 0 });

  useEffect(() => {
    setDims({ w: 0, h: 0 });
    if (!imageUrl) return;
    const img = new Image();
    img.onload = () => setDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageUrl;
  }, [imageUrl]);

  if (!imageUrl) return <div className="region-crop-fallback">No valid region</div>;
  if (!dims.w || !dims.h) return <div className="region-crop-fallback">Loading crop...</div>;

  const expanded = expandRegion(region, dims.w, dims.h, textBias ? 0.62 : 0.42);
  if (!expanded) return <div className="region-crop-fallback">No valid region</div>;

  const frame = 124;
  const scale = frame / Math.max(expanded.width, expanded.height, 1);

  return (
    <div className="region-crop-frame" aria-label={label} title={label}>
      <img
        src={imageUrl}
        alt={label}
        className="region-crop-image"
        style={{
          width: `${dims.w * scale}px`,
          height: `${dims.h * scale}px`,
          left: `${-expanded.x * scale}px`,
          top: `${-expanded.y * scale}px`,
        }}
      />
    </div>
  );
}

function OverlayChip({ label, active, onClick, disabled }) {
  return (
    <button
      type="button"
      className={`overlay-chip ${active ? 'overlay-chip--active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title="Click to highlight this on the image"
    >
      {label}
    </button>
  );
}

export default function ImageDetailModal({
  image,
  regionConnections,
  activeConnection,
  getDrawingDisplayName,
  getArchiveRecord,
  getArchiveSecondaryLine,
  onClose,
  onNavigateToLinked,
  onBackToGraph,
}) {
  const [naturalW, setNaturalW] = useState(0);
  const [naturalH, setNaturalH] = useState(0);

  const [activeOverlayTypes, setActiveOverlayTypes] = useState([]);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [hoveredConnection, setHoveredConnection] = useState(null);
  const [selectedTextBlock, setSelectedTextBlock] = useState(null);
  const [selectedRegionType, setSelectedRegionType] = useState(null);

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [openInspectorSections, setOpenInspectorSections] = useState({
    title: false,
    text: false,
    keywords: false,
    regionTypes: false,
  });
  const [selectedKeyword, setSelectedKeyword] = useState(null);
  const [focusRegion, setFocusRegion] = useState(null);

  const imgRef = useRef(null);
  const stageRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    setNaturalW(0);
    setNaturalH(0);
    setHoveredConnection(null);
    setSelectedConnection(activeConnection || null);
    setSelectedTextBlock(null);
    setSelectedRegionType(null);
    setSelectedKeyword(null);
    setFocusRegion(null);
    setActiveOverlayTypes(['title']);
    setOpenInspectorSections({
      title: false,
      text: false,
      keywords: false,
      regionTypes: false,
    });
  }, [image?.url, activeConnection]);

  const handleImageLoad = useCallback((e) => {
    setNaturalW(e.target.naturalWidth);
    setNaturalH(e.target.naturalHeight);
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      setNaturalW(img.naturalWidth);
      setNaturalH(img.naturalHeight);
    }
  }, [image?.url]);

  const visibleRegions = useMemo(() => {
    if (!image) return [];
    return regionConnections
      .filter((rc) => rc.source_instance_id === image.instance_id || rc.target_instance_id === image.instance_id)
      .sort((a, b) => b.confidence_score - a.confidence_score)
      .slice(0, MAX_VISIBLE_REGIONS);
  }, [image, regionConnections]);

  useEffect(() => {
    if (!selectedConnection && visibleRegions.length) {
      setSelectedConnection(activeConnection || visibleRegions[0]);
    }
  }, [activeConnection, selectedConnection, visibleRegions]);

  const extracted = image?.extractedText || {};
  const textBlocks = Array.isArray(extracted.textBlocks) ? extracted.textBlocks : [];
  const keywords = Array.isArray(extracted.keywords) ? extracted.keywords : [];
  const regions = Array.isArray(image?.regions) ? image.regions : [];
  const regionTypes = image?.regionTypes || {};

  const titleBlocks = useMemo(() => textBlocks.filter((t) => (t.role || '').toLowerCase() === 'title'), [textBlocks]);
  const chartRegions = useMemo(() => regions.filter((r) => /chart/i.test(r?.type || '')), [regions]);
  const diagramRegions = useMemo(() => regions.filter((r) => /diagram/i.test(r?.type || '')), [regions]);

  const regionByGridId = useMemo(() => {
    const map = new Map();
    regions.forEach((r) => {
      if (r?.gridId) map.set(r.gridId, r);
    });
    return map;
  }, [regions]);

  const keywordMatches = useMemo(() => {
    if (!selectedKeyword) return [];
    const needle = selectedKeyword.toLowerCase();
    return textBlocks.filter((b) => String(b.text || '').toLowerCase().includes(needle));
  }, [selectedKeyword, textBlocks]);

  const getRegionForCurrentImage = useCallback((rc) => {
    if (!image || !rc) return null;
    const isSource = rc.source_instance_id === image.instance_id;
    return isSource ? rc.source_region : rc.target_region;
  }, [image]);

  useEffect(() => {
    if (!focusRegion || !naturalW || !naturalH) return;
    const wrapper = wrapperRef.current;
    const stage = stageRef.current;
    if (!wrapper || !stage) return;

    const renderedW = wrapper.clientWidth;
    const renderedH = wrapper.clientHeight;
    if (!renderedW || !renderedH) return;

    const normalized = normalizeRegion(focusRegion, naturalW, naturalH);
    if (!normalized) return;

    const scaleX = renderedW / naturalW;
    const scaleY = renderedH / naturalH;
    const cx = (normalized.x + normalized.width / 2) * scaleX;
    const cy = (normalized.y + normalized.height / 2) * scaleY;

    stage.scrollTo({
      left: Math.max(0, cx - stage.clientWidth / 2),
      top: Math.max(0, cy - stage.clientHeight / 2),
      behavior: 'smooth',
    });
  }, [focusRegion, naturalW, naturalH]);

  if (!image) return null;

  const ready = naturalW > 0 && naturalH > 0;
  const currentDrawingName = getDrawingDisplayName ? getDrawingDisplayName(image) : image.title;
  const currentSecondaryLine = getArchiveSecondaryLine ? getArchiveSecondaryLine(image) : null;

  const selectedTargetId = selectedConnection
    ? (selectedConnection.source_instance_id === image.instance_id
      ? selectedConnection.target_instance_id
      : selectedConnection.source_instance_id)
    : null;

  const selectedTargetName = selectedTargetId
    ? (getDrawingDisplayName ? getDrawingDisplayName(selectedTargetId) : selectedTargetId)
    : null;

  const relatedConnections = visibleRegions
    .filter((rc) => rc.id !== selectedConnection?.id)
    .slice(0, 8);

  const hasBoardTitle = Boolean(image.canonical_board_title || image.board_title || titleBlocks.length);
  const hasText = textBlocks.length > 0;
  const hasChart = chartRegions.length > 0;
  const hasKeywords = keywords.length > 0;
  const strongTitle = (image.board_title_confidence ?? 0) >= 0.7;

  const toggleOverlayType = (type) => {
    setActiveOverlayTypes((prev) => (
      prev.includes(type) ? prev.filter((v) => v !== type) : [...prev, type]
    ));
  };

  const toggleInspectorSection = (sectionKey) => {
    setOpenInspectorSections((prev) => ({
      ...prev,
      [sectionKey]: !prev[sectionKey],
    }));
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-shell evidence-modal-shell">
        <header className="modal-header evidence-modal-header">
          <div className="modal-title-block">
            <h2 className="modal-title">{currentDrawingName}</h2>
            {currentSecondaryLine && <p className="modal-secondary-line">{currentSecondaryLine}</p>}
          </div>
          <div className="header-actions">
            <button type="button" onClick={onBackToGraph}>Back to graph</button>
            <button type="button" onClick={onClose} aria-label="Close">Close</button>
          </div>
        </header>

        <div className="modal-body evidence-modal-body">
          <section className="image-stage evidence-image-stage" ref={stageRef}>
            <div className="evidence-toolbar">
              <p className="evidence-helper">Click a chip or inspector item to see where it appears on the board.</p>
              <div className="evidence-chips">
                <OverlayChip
                  label="Board title"
                  active={activeOverlayTypes.includes('title')}
                  disabled={!hasBoardTitle}
                  onClick={() => toggleOverlayType('title')}
                />
                <OverlayChip
                  label="Chart"
                  active={activeOverlayTypes.includes('chart')}
                  disabled={!hasChart}
                  onClick={() => toggleOverlayType('chart')}
                />
                <OverlayChip
                  label="Keywords"
                  active={activeOverlayTypes.includes('keywords')}
                  disabled={!hasKeywords}
                  onClick={() => {
                    toggleOverlayType('keywords');
                    if (!selectedKeyword && keywords.length) setSelectedKeyword(keywords[0]);
                  }}
                />
                <OverlayChip
                  label="Text present"
                  active={activeOverlayTypes.includes('text')}
                  disabled={!hasText}
                  onClick={() => toggleOverlayType('text')}
                />
                <OverlayChip
                  label="Strong title"
                  active={activeOverlayTypes.includes('strong-title')}
                  disabled={!strongTitle}
                  onClick={() => toggleOverlayType('strong-title')}
                />
              </div>
              <button
                type="button"
                className="inspector-toggle"
                onClick={() => setInspectorOpen((v) => !v)}
                title="Click to show extracted data inspector"
              >
                {inspectorOpen ? 'Hide Inspector' : 'Show Inspector'}
              </button>
            </div>

            {inspectorOpen && (
              <div className="evidence-inspector">
                <div className="inspector-section">
                  <button
                    type="button"
                    className="inspector-section-header"
                    onClick={() => toggleInspectorSection('title')}
                  >
                    Board title {openInspectorSections.title ? '−' : '+'}
                  </button>
                  {openInspectorSections.title && (
                    <button
                      type="button"
                      className="inspector-item"
                      onClick={() => {
                        setActiveOverlayTypes((prev) => (prev.includes('title') ? prev : [...prev, 'title']));
                        const firstTitle = titleBlocks[0]?.bbox || null;
                        if (firstTitle) {
                          setSelectedTextBlock(titleBlocks[0]);
                          setFocusRegion(firstTitle);
                        }
                      }}
                      title="Click to highlight this on the image"
                      disabled={!titleBlocks.length}
                    >
                      {image.canonical_board_title || image.board_title || 'No title detected'}
                    </button>
                  )}
                </div>

                <div className="inspector-section">
                  <button
                    type="button"
                    className="inspector-section-header"
                    onClick={() => toggleInspectorSection('text')}
                  >
                    Text {openInspectorSections.text ? '−' : '+'}
                  </button>
                  {openInspectorSections.text && (
                    <div className="inspector-list">
                      {textBlocks.slice(0, 8).map((block, idx) => (
                        <button
                          key={`${idx}-${block.text?.slice(0, 20)}`}
                          type="button"
                          className={`inspector-item ${selectedTextBlock === block ? 'inspector-item--active' : ''}`}
                          onClick={() => {
                            setSelectedTextBlock(block);
                            setSelectedRegionType(null);
                            setActiveOverlayTypes((prev) => (prev.includes('text') ? prev : [...prev, 'text']));
                            setFocusRegion(block.bbox);
                          }}
                          title="Click to highlight this on the image"
                        >
                          {String(block.text || '').slice(0, 110)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="inspector-section">
                  <button
                    type="button"
                    className="inspector-section-header"
                    onClick={() => toggleInspectorSection('keywords')}
                  >
                    Keywords {openInspectorSections.keywords ? '−' : '+'}
                  </button>
                  {openInspectorSections.keywords && (
                    <div className="inspector-tags">
                      {keywords.slice(0, 20).map((kw) => (
                        <button
                          key={kw}
                          type="button"
                          className={`inspector-tag ${selectedKeyword === kw ? 'inspector-tag--active' : ''}`}
                          onClick={() => {
                            setSelectedKeyword(kw);
                            setActiveOverlayTypes((prev) => (prev.includes('keywords') ? prev : [...prev, 'keywords']));
                            const firstMatch = textBlocks.find((b) =>
                              String(b.text || '').toLowerCase().includes(kw.toLowerCase())
                            );
                            if (firstMatch?.bbox) setFocusRegion(firstMatch.bbox);
                          }}
                          title="Click to highlight this on the image"
                        >
                          {kw}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="inspector-section">
                  <button
                    type="button"
                    className="inspector-section-header"
                    onClick={() => toggleInspectorSection('regionTypes')}
                  >
                    Region types {openInspectorSections.regionTypes ? '−' : '+'}
                  </button>
                  {openInspectorSections.regionTypes && (
                    <div className="inspector-list">
                      {Object.entries(regionTypes).map(([type, gridIds]) => (
                        <button
                          key={type}
                          type="button"
                          className={`inspector-item ${selectedRegionType === type ? 'inspector-item--active' : ''}`}
                          onClick={() => {
                            setSelectedRegionType(type);
                            setSelectedTextBlock(null);

                            if (/chart/i.test(type)) {
                              setActiveOverlayTypes((prev) => (prev.includes('chart') ? prev : [...prev, 'chart']));
                            } else if (/diagram/i.test(type)) {
                              setActiveOverlayTypes((prev) => (prev.includes('diagram') ? prev : [...prev, 'diagram']));
                            } else if (/blank/i.test(type)) {
                              setActiveOverlayTypes((prev) => (prev.includes('weak') ? prev : [...prev, 'weak']));
                            }

                            const firstGridId = Array.isArray(gridIds) ? gridIds[0] : null;
                            const firstRegion = firstGridId ? regionByGridId.get(firstGridId) : null;
                            if (firstRegion?.bbox) setFocusRegion(firstRegion.bbox);
                          }}
                          title="Click to highlight this on the image"
                        >
                          {type.replace(/_/g, ' ')} ({Array.isArray(gridIds) ? gridIds.length : 0})
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="image-overlay-wrapper" ref={wrapperRef}>
              <img
                ref={imgRef}
                src={image.url}
                alt={currentDrawingName}
                className="detail-image"
                onLoad={handleImageLoad}
              />

              {ready && (
                <>
                  {activeOverlayTypes.includes('title') && titleBlocks.map((tb, idx) => (
                    <OverlayBox
                      key={`title-${idx}`}
                      region={tb.bbox}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--title"
                      color="#fbbf24"
                      title="Title region"
                    />
                  ))}

                  {activeOverlayTypes.includes('strong-title') && titleBlocks.map((tb, idx) => (
                    <OverlayBox
                      key={`strong-title-${idx}`}
                      region={tb.bbox}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--strong-title"
                      color="#f59e0b"
                      title="Strong title region"
                    />
                  ))}

                  {activeOverlayTypes.includes('text') && textBlocks.map((tb, idx) => (
                    <OverlayBox
                      key={`text-${idx}`}
                      region={tb.bbox}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--text"
                      color="#3b82f6"
                      title="Extracted text block"
                    />
                  ))}

                  {activeOverlayTypes.includes('keywords') && (selectedKeyword ? keywordMatches : textBlocks).map((tb, idx) => (
                    <OverlayBox
                      key={`kw-${idx}`}
                      region={tb.bbox}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--keywords"
                      color="#60a5fa"
                      title="Keyword-related text"
                    />
                  ))}

                  {activeOverlayTypes.includes('chart') && chartRegions.map((r) => (
                    <OverlayBox
                      key={`chart-${r.gridId}`}
                      region={r.bbox}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--chart"
                      color="#f97316"
                      title="Chart region"
                    />
                  ))}

                  {activeOverlayTypes.includes('diagram') && diagramRegions.map((r) => (
                    <OverlayBox
                      key={`diagram-${r.gridId}`}
                      region={r.bbox}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--diagram"
                      color="#22c55e"
                      title="Diagram region"
                    />
                  ))}

                  {activeOverlayTypes.includes('weak') && visibleRegions
                    .filter((rc) => isWeakRegion(rc, image.instance_id))
                    .map((rc) => (
                      <OverlayBox
                        key={`weak-${rc.id}`}
                        region={getRegionForCurrentImage(rc)}
                        naturalW={naturalW}
                        naturalH={naturalH}
                        className="evidence-overlay evidence-overlay--weak"
                        color="#ef4444"
                        title="Weak / low-detail region"
                      />
                    ))}

                  {hoveredConnection && (
                    <OverlayBox
                      region={getRegionForCurrentImage(hoveredConnection)}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--hovered-connection"
                      color="#14b8a6"
                      title="Hovered linked region"
                    />
                  )}

                  {selectedConnection && (
                    <OverlayBox
                      region={getRegionForCurrentImage(selectedConnection)}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--selected-connection"
                      color="#22d3ee"
                      title="Selected linked region"
                    />
                  )}

                  {selectedTextBlock?.bbox && (
                    <OverlayBox
                      region={selectedTextBlock.bbox}
                      naturalW={naturalW}
                      naturalH={naturalH}
                      className="evidence-overlay evidence-overlay--selected-text"
                      color="#2563eb"
                      title="Selected text block"
                    />
                  )}

                  {selectedRegionType && (regionTypes[selectedRegionType] || []).map((gridId) => {
                    const region = regionByGridId.get(gridId);
                    if (!region?.bbox) return null;
                    const className = /diagram/i.test(selectedRegionType)
                      ? 'evidence-overlay evidence-overlay--diagram'
                      : /chart/i.test(selectedRegionType)
                      ? 'evidence-overlay evidence-overlay--chart'
                      : /blank/i.test(selectedRegionType)
                      ? 'evidence-overlay evidence-overlay--weak'
                      : 'evidence-overlay evidence-overlay--text';

                    return (
                      <OverlayBox
                        key={`selected-type-${selectedRegionType}-${gridId}`}
                        region={region.bbox}
                        naturalW={naturalW}
                        naturalH={naturalH}
                        className={className}
                        color="#14b8a6"
                        title={`Region type: ${selectedRegionType}`}
                      />
                    );
                  })}
                </>
              )}
            </div>
          </section>

          <aside className="modal-sidebar evidence-sidebar">
            <h3>Evidence Links</h3>

            {selectedConnection ? (
              <div className="selected-connection-panel">
                <p className="selected-connection-label">Selected connection</p>
                <strong>{selectedTargetName || 'Linked drawing'}</strong>

                <div className="region-crop-pair">
                  <div>
                    <small className="subtle">Source crop</small>
                    <RegionCropPreview
                      imageUrl={image.url}
                      region={getRegionForCurrentImage(selectedConnection)}
                      label="Source crop"
                      textBias={Boolean((selectedConnection.evidence_kinds || []).includes('text'))}
                    />
                  </div>
                  <div>
                    <small className="subtle">Linked crop</small>
                    <RegionCropPreview
                      imageUrl={selectedTargetId ? getArchiveRecord(selectedTargetId)?.url : null}
                      region={selectedConnection.source_instance_id === image.instance_id ? selectedConnection.target_region : selectedConnection.source_region}
                      label="Linked crop"
                      textBias={Boolean((selectedConnection.evidence_kinds || []).includes('text'))}
                    />
                  </div>
                </div>

                <p className="subtle">{getConnectionLabel(selectedConnection.connection_type)}</p>
                <EvidenceTags type={selectedConnection.connection_type} evidenceKinds={selectedConnection.evidence_kinds} />
                <p className="region-card-explanation">
                  {localEvidenceExplanation(selectedConnection, image.instance_id)}
                </p>
                <small className="subtle">
                  <span className={`conf-badge ${getConfidenceLabel(selectedConnection.confidence_score).cls}`}>
                    {getConfidenceLabel(selectedConnection.confidence_score).label}
                  </span>
                  {' '}{selectedConnection.confidence_score.toFixed(2)}
                  {' · '}{getMatchSource(selectedConnection.connection_type)}
                </small>
              </div>
            ) : (
              <p className="subtle">Select a connection to inspect linked evidence.</p>
            )}

            <div className="region-list evidence-region-list">
              <p className="subtle evidence-related-label">Related connections</p>

              {relatedConnections.map((rc) => {
                const isSource = rc.source_instance_id === image.instance_id;
                const targetId = isSource ? rc.target_instance_id : rc.source_instance_id;
                const linkedName = getDrawingDisplayName ? getDrawingDisplayName(targetId) : targetId;

                return (
                  <button
                    key={rc.id}
                    type="button"
                    className={`region-card ${hoveredConnection?.id === rc.id ? 'region-card--highlighted' : ''}`}
                    onMouseEnter={() => setHoveredConnection(rc)}
                    onMouseLeave={() => setHoveredConnection(null)}
                    onClick={() => {
                      setSelectedConnection(rc);
                      setFocusRegion(getRegionForCurrentImage(rc));
                    }}
                    title="Click to highlight this on the image"
                  >
                    <span
                      className="dot"
                      style={{ backgroundColor: connectionColors[rc.connection_type] || '#94a3b8' }}
                    />
                    <div className="region-card-body">
                      <strong>{linkedName}</strong>
                      <EvidenceTags type={rc.connection_type} evidenceKinds={rc.evidence_kinds} />

                      <div className="region-crop-pair">
                        <RegionCropPreview
                          imageUrl={image.url}
                          region={getRegionForCurrentImage(rc)}
                          label="Source crop"
                          textBias={Boolean((rc.evidence_kinds || []).includes('text'))}
                        />
                        <RegionCropPreview
                          imageUrl={targetId ? getArchiveRecord(targetId)?.url : null}
                          region={isSource ? rc.target_region : rc.source_region}
                          label="Linked crop"
                          textBias={Boolean((rc.evidence_kinds || []).includes('text'))}
                        />
                      </div>

                      {isWeakRegion(rc, image.instance_id) && <span className="weak-region-badge">Weak / low-detail</span>}

                      <p className="region-card-explanation">
                        {localEvidenceExplanation(rc, image.instance_id)}
                      </p>

                      <small className="subtle">
                        {getConnectionLabel(rc.connection_type)}
                        {' · '}
                        <span className={`conf-badge ${getConfidenceLabel(rc.confidence_score).cls}`}>
                          {getConfidenceLabel(rc.confidence_score).label}
                        </span>
                      </small>

                      <div className="region-card-actions">
                        <button
                          type="button"
                          className="jump-linked-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onNavigateToLinked(rc, targetId);
                          }}
                          title="Open linked drawing"
                        >
                          Open linked drawing
                        </button>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
