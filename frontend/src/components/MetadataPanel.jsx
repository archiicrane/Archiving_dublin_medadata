export default function MetadataPanel({ image, drawingDisplayName, archiveSecondaryLine }) {
  if (!image) {
    return (
      <div className="panel metadata-panel">
        <h3>Reading Help</h3>
        <p className="subtle">Pick any drawing in the graph to open a record summary here.</p>
        <ul className="guide-list">
          <li>Title tells you what the drawing is about.</li>
          <li>Subject and description provide historical context.</li>
          <li>Source and identifier help trace where it came from.</li>
        </ul>
      </div>
    );
  }

  const dc = image.dublin_core || {};
  const subjects = Array.isArray(dc['dc:subject']) ? dc['dc:subject'].join(', ') : dc['dc:subject'];
  const summary = dc['dc:description'] || image.contentSummary || 'No written summary is available for this record yet.';

  return (
    <div className="panel metadata-panel">
      <h3>Selected Record</h3>
      <p className="meta-record-title">{drawingDisplayName || image.title}</p>
      {archiveSecondaryLine
        ? <p className="subtle meta-secondary-line">{archiveSecondaryLine}</p>
        : <p className="subtle">{image.instance_id}</p>
      }

      <div className="meta-summary-block">
        <p className="meta-summary-label">What this drawing helps explain</p>
        <p className="meta-summary-text">{summary}</p>
      </div>

      <ul className="meta-list">
        <li><strong>Title:</strong> {dc['dc:title'] || '-'}</li>
        <li><strong>Creator:</strong> {dc['dc:creator'] || '-'}</li>
        <li><strong>Contributor:</strong> {dc['dc:contributor'] || '-'}</li>
        <li><strong>Subject:</strong> {subjects || '-'}</li>
        <li><strong>Date:</strong> {String(dc['dc:date'] ?? '-')}</li>
        <li><strong>Collection:</strong> {dc['dc:relation'] || '-'}</li>
        <li><strong>Source:</strong> {dc['dc:source'] || '-'}</li>
        <li><strong>Record ID:</strong> {dc['dc:identifier'] || '-'}</li>
      </ul>

      <details className="meta-details">
        <summary>See full Dublin Core fields</summary>
        <ul className="meta-list">
          <li><strong>dc:type:</strong> {dc['dc:type'] || '-'}</li>
          <li><strong>dc:format:</strong> {dc['dc:format'] || '-'}</li>
          <li><strong>dc:language:</strong> {dc['dc:language'] || '-'}</li>
          <li><strong>dc:publisher:</strong> {dc['dc:publisher'] || '-'}</li>
          <li><strong>dc:coverage:</strong> {dc['dc:coverage'] || '-'}</li>
          <li><strong>dc:rights:</strong> {dc['dc:rights'] || '-'}</li>
        </ul>
      </details>

      <ul className="meta-list">
        <li><strong>Why it is linked:</strong> related visual or textual patterns in the graph.</li>
      </ul>
    </div>
  );
}
