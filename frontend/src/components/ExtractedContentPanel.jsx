import { useState } from 'react';

/**
 * Displays extracted content from a board image:
 * - Text blocks with roles
 * - Detected region types (diagram, map, text, etc.)
 * - Semantic tags
 * - Content summary
 */
export function ExtractedContentPanel({ image }) {
  const [showTextBlocks, setShowTextBlocks] = useState(false);
  const [showRegions, setShowRegions] = useState(false);

  if (!image) return null;

  const extracted = image.extractedText || {};
  const regions = image.regions || [];
  const regionTypes = image.regionTypes || {};
  const tags = image.semanticTags || [];
  const summary = image.contentSummary || '';

  // Text blocks by role
  const textBlocks = extracted.textBlocks || [];
  const titleBlocks = textBlocks.filter((t) => t.role === 'title');
  const headingBlocks = textBlocks.filter((t) => t.role === 'heading');
  const bodyBlocks = textBlocks.filter((t) => t.role === 'body');
  const labelBlocks = textBlocks.filter((t) => t.role === 'label');

  // Keywords
  const keywords = extracted.keywords || [];

  // Semantic tag display
  const semanticTagLabels = {
    has_text: '📄 Text present',
    has_keywords: '🔑 Keywords',
    has_board_title: '📌 Board title',
    strong_board_title: '✓ Strong title',
    has_title_block: '🎯 Title block',
    has_diagram: '📐 Diagram',
    has_map: '🗺️ Map',
    has_render: '🎨 3D render',
    has_chart: '📊 Chart',
    has_photo: '📷 Photography',
    has_legend: '🗝️ Legend',
  };

  const visibleTags = tags.filter((t) => semanticTagLabels[t]);

  return (
    <div className="extracted-content-panel">
      {/* Summary line */}
      {summary && (
        <div className="content-summary">
          <span className="summary-icon">ℹ️</span>
          <span className="summary-text">{summary}</span>
        </div>
      )}

      {/* Semantic tags grid */}
      {visibleTags.length > 0 && (
        <div className="semantic-tags-grid">
          {visibleTags.map((tag) => (
            <span key={tag} className="semantic-tag">
              {semanticTagLabels[tag]}
            </span>
          ))}
        </div>
      )}

      {/* Text blocks expandable section */}
      {textBlocks.length > 0 && (
        <div className="content-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setShowTextBlocks((v) => !v)}
          >
            <span className="toggle-icon">{showTextBlocks ? '▼' : '▶'}</span>
            <span>Extracted Text Blocks ({textBlocks.length})</span>
          </button>
          {showTextBlocks && (
            <div className="section-content">
              {titleBlocks.length > 0 && (
                <div className="text-block-group">
                  <span className="role-label">Titles</span>
                  {titleBlocks.map((block, i) => (
                    <div key={i} className="text-block">
                      <span className="confidence">
                        {Math.round(block.confidence * 100)}%
                      </span>
                      <span className="text">{block.text.substring(0, 100)}</span>
                    </div>
                  ))}
                </div>
              )}
              {headingBlocks.length > 0 && (
                <div className="text-block-group">
                  <span className="role-label">Headings</span>
                  {headingBlocks.map((block, i) => (
                    <div key={i} className="text-block">
                      <span className="confidence">
                        {Math.round(block.confidence * 100)}%
                      </span>
                      <span className="text">{block.text.substring(0, 100)}</span>
                    </div>
                  ))}
                </div>
              )}
              {labelBlocks.length > 0 && (
                <div className="text-block-group">
                  <span className="role-label">Labels / Annotations</span>
                  {labelBlocks.map((block, i) => (
                    <div key={i} className="text-block">
                      <span className="confidence">
                        {Math.round(block.confidence * 100)}%
                      </span>
                      <span className="text">{block.text.substring(0, 100)}</span>
                    </div>
                  ))}
                </div>
              )}
              {bodyBlocks.length > 0 && (
                <div className="text-block-group">
                  <span className="role-label">Body Text</span>
                  <p className="subtle">
                    {bodyBlocks.length} body text block(s) detected
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Region types expandable section */}
      {Object.keys(regionTypes).length > 0 && (
        <div className="content-section">
          <button
            type="button"
            className="section-toggle"
            onClick={() => setShowRegions((v) => !v)}
          >
            <span className="toggle-icon">{showRegions ? '▼' : '▶'}</span>
            <span>Detected Region Types ({regions.length})</span>
          </button>
          {showRegions && (
            <div className="section-content">
              {Object.entries(regionTypes)
                .filter(([type, _]) => type !== 'blank_region')
                .map(([type, gridIds]) => (
                  <div key={type} className="region-type-group">
                    <span className="region-type-label">
                      {type.replace(/_/g, ' ')} ({gridIds.length})
                    </span>
                    <span className="region-ids">
                      {gridIds.join(', ')}
                    </span>
                  </div>
                ))}
              {regionTypes.blank_region && regionTypes.blank_region.length > 0 && (
                <div className="region-type-group blank">
                  <span className="region-type-label subtle">
                    Blank / low-info regions ({regionTypes.blank_region.length})
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Keywords if any */}
      {keywords.length > 0 && (
        <div className="keywords-section">
          <span className="keywords-label">Keywords:</span>
          <div className="keywords-list">
            {keywords.slice(0, 8).map((kw) => (
              <span key={kw} className="keyword">
                {kw}
              </span>
            ))}
            {keywords.length > 8 && (
              <span className="keyword subtle">+{keywords.length - 8} more</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
