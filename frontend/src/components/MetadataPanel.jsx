export default function MetadataPanel({ image, drawingDisplayName, archiveSecondaryLine }) {
  if (!image) {
    return (
      <div className="panel metadata-panel">
        <h3>Metadata</h3>
        <p>Select a node to inspect Dublin Core metadata.</p>
      </div>
    );
  }

  const dc = image.dublin_core || {};
  const subjects = Array.isArray(dc['dc:subject']) ? dc['dc:subject'].join(', ') : dc['dc:subject'];

  return (
    <div className="panel metadata-panel">
      <h3>{drawingDisplayName || image.title}</h3>
      {archiveSecondaryLine
        ? <p className="subtle meta-secondary-line">{archiveSecondaryLine}</p>
        : <p className="subtle">{image.instance_id}</p>
      }
      <ul className="meta-list">
        <li><strong>dc:title:</strong> {dc['dc:title'] || '-'}</li>
        <li><strong>dc:creator:</strong> {dc['dc:creator'] || '-'}</li>
        <li><strong>dc:contributor:</strong> {dc['dc:contributor'] || '-'}</li>
        <li><strong>dc:subject:</strong> {subjects || '-'}</li>
        <li><strong>dc:description:</strong> {dc['dc:description'] || '-'}</li>
        <li><strong>dc:date:</strong> {String(dc['dc:date'] ?? '-')}</li>
        <li><strong>dc:type:</strong> {dc['dc:type'] || '-'}</li>
        <li><strong>dc:format:</strong> {dc['dc:format'] || '-'}</li>
        <li><strong>dc:language:</strong> {dc['dc:language'] || '-'}</li>
        <li><strong>dc:publisher:</strong> {dc['dc:publisher'] || '-'}</li>
        <li><strong>dc:identifier:</strong> {dc['dc:identifier'] || '-'}</li>
        <li><strong>dc:source:</strong> {dc['dc:source'] || '-'}</li>
        <li><strong>dc:relation:</strong> {dc['dc:relation'] || '-'}</li>
        <li><strong>dc:coverage:</strong> {dc['dc:coverage'] || '-'}</li>
        <li><strong>dc:rights:</strong> {dc['dc:rights'] || '-'}</li>
      </ul>
    </div>
  );
}
