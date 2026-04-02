import { useEffect, useState } from 'react';
import { connectionLabels } from '../utils/colorSystem';

export default function FiltersPanel({
  filters,
  setFilters,
  subjects,
  clusters,
  connectionTypes,
  totalDrawings,
  visibleDrawings,
  visibleConnections,
  onResetFilters,
}) {
  const [searchDraft, setSearchDraft] = useState(filters.searchQuery || '');

  useEffect(() => {
    setSearchDraft(filters.searchQuery || '');
  }, [filters.searchQuery]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.searchQuery || '') !== searchDraft) {
        setFilters({ ...filters, searchQuery: searchDraft });
      }
    }, 320);

    return () => clearTimeout(timer);
  }, [searchDraft]);

  const toggleConnection = (type) => {
    const next = new Set(filters.connectionTypes);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    setFilters({ ...filters, connectionTypes: next });
  };

  return (
    <div className="panel filters-panel">
      <div className="panel-title-row">
        <h3>Archive Guide</h3>
        <button type="button" className="panel-inline-btn" onClick={onResetFilters}>Reset</button>
      </div>

      <div className="guide-block">
        <p className="guide-title">Start here</p>
        <ol className="guide-steps">
          <li>Search a topic, place, or material.</li>
          <li>Choose one subject or competition to narrow the map.</li>
          <li>Click any dot to open the drawing record and context.</li>
        </ol>
      </div>

      <div className="stats-grid">
        <div>
          <small>Total Drawings</small>
          <strong>{totalDrawings}</strong>
        </div>
        <div>
          <small>Visible Drawings</small>
          <strong>{visibleDrawings}</strong>
        </div>
        <div>
          <small>Visible Connections</small>
          <strong>{visibleConnections}</strong>
        </div>
      </div>

      <label>Find in archive</label>
      <input
        type="text"
        placeholder="Try: housing, tree, section, Lisbon"
        value={searchDraft}
        onChange={(e) => setSearchDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setFilters({ ...filters, searchQuery: searchDraft });
          }
        }}
      />
      <div className="quick-search-row">
        {['housing', 'tree', 'site plan'].map((term) => (
          <button
            type="button"
            key={term}
            className="quick-search-btn"
            onClick={() => setFilters({ ...filters, searchQuery: term })}
          >
            {term}
          </button>
        ))}
      </div>

      <label className="filter-label">
        Connection strength: <strong>{filters.minWeight.toFixed(2)}</strong>
      </label>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={filters.minWeight}
        aria-label="Minimum edge weight threshold"
        onChange={(e) => setFilters({ ...filters, minWeight: Number(e.target.value) })}
      />
      <small className="filter-hint">
        Higher values show only the most strongly related drawings.
      </small>

      <label>How drawings are related</label>
      <div className="chips">
        {connectionTypes.map((type) => (
          <button
            type="button"
            key={type}
            className={filters.connectionTypes.has(type) ? 'chip active' : 'chip'}
            onClick={() => toggleConnection(type)}
          >
            {connectionLabels[type] || type}
          </button>
        ))}
      </div>

      <label>Subject focus</label>
      <select
        value={filters.subject}
        onChange={(e) => setFilters({ ...filters, subject: e.target.value })}
      >
        <option value="">All Subjects</option>
        {subjects.map((subject) => (
          <option key={subject} value={subject}>
            {subject}
          </option>
        ))}
      </select>

      <label>Competition or collection</label>
      <select
        value={filters.cluster}
        onChange={(e) => setFilters({ ...filters, cluster: e.target.value })}
      >
        <option value="">All Competitions</option>
        {clusters.map((cluster) => (
          <option key={cluster.value || String(cluster)} value={cluster.value || String(cluster)}>
            {cluster.label || `Cluster ${cluster}`} {cluster.count ? `(${cluster.count})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
