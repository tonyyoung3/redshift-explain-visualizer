import React, { useState, useRef, useEffect } from "react";
import Editor from "react-simple-code-editor";
import { highlight, languages } from "prismjs";
import "prismjs/components/prism-sql"; // Import SQL language for highlighting
import "prismjs/themes/prism.css"; // Default Prism theme
import mermaid from "mermaid";

// Helper function to render markdown links
function renderMessageWithLinks(message) {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = linkRegex.exec(message)) !== null) {
    if (match.index > lastIndex) {
      parts.push(message.substring(lastIndex, match.index));
    }
    const [fullMatch, linkText, linkUrl] = match;
    parts.push({ text: linkText, url: linkUrl, isLink: true });
    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < message.length) {
    parts.push(message.substring(lastIndex));
  }

  return (
    <>{parts.map((part, index) => {
      if (part.isLink) {
        return <a key={index} href={part.url} target="_blank" rel="noopener noreferrer" style={{color: '#0d47a1'}}>{part.text}</a>;
      }
      return <React.Fragment key={index}>{part}</React.Fragment>;
    })}</>
  );
}

// Analyze EXPLAIN plan for performance warnings
function analyzePerformanceWarnings(nodeInfos) {
  const warnings = [];

  for (const nodeId in nodeInfos) {
    const node = nodeInfos[nodeId];
    
    // Add safety checks
    if (!node || !node.details || !Array.isArray(node.details) || node.details.length === 0) {
      continue; // Skip this node if it doesn't have valid details
    }
    
    const content = node.details[0]; // Now safe to access

    // Check for Nested Loop joins
    if (content.includes('Nested Loop')) {
      warnings.push({
        type: 'warning',
        message: '⚠️ Nested Loop join detected. This can be very slow if the inner table is large. Consider adding proper join conditions or indexes. [Learn more](https://docs.aws.amazon.com/redshift/latest/dg/c_Nested_loop_join.html)',
        severity: 'high',
        nodeId: nodeId
      });
    }
    
    // Check for large Seq Scans
    if (content.includes('Seq Scan')) {
      const rowsMatch = content.match(/rows=(\d+)/);
      if (rowsMatch) {
        const rows = parseInt(rowsMatch[1]);
        if (rows > 10000) {
          warnings.push({
            type: 'warning',
            message: `⚠️ Large Seq Scan detected (${rows.toLocaleString()} rows). Consider adding a sort key or filter conditions to reduce the scan size. [Learn more](https://docs.aws.amazon.com/redshift/latest/dg/t_Analyzing_tables.html)`,
            severity: 'medium',
            nodeId: nodeId
          });
        }
      }
    }
    
    // Check for DS_BCAST operations
    if (content.includes('DS_BCAST')) {
      warnings.push({
        type: 'info',
        message: 'ℹ️ Broadcast operation detected. Ensure the inner table being broadcast is small to avoid high network traffic. [Learn more](https://docs.aws.amazon.com/redshift/latest/dg/r_SVL_QUERY_REPORT.html#r_SVL_QUERY_REPORT-ds_bcast_inner)',
        severity: 'medium',
        nodeId: nodeId
      });
    }

    // Check for expensive Hash operations using exclusive cost
    if (content.includes('Hash') && node.exclusiveCost > 50) {
      warnings.push({
        type: 'warning',
        message: `⚠️ Expensive Hash operation detected (exclusive cost: ${node.exclusiveCost.toFixed(2)}). Consider if this hash step is necessary or if the data can be pre-sorted. [Learn more](https://docs.aws.amazon.com/redshift/latest/dg/c_Hash_join.html)`,
        severity: 'medium',
        nodeId: nodeId
      });
    }
  }

  // Remove duplicate warnings
  const uniqueWarnings = warnings.filter((warning, index, self) => 
    index === self.findIndex(w => w.message === warning.message)
  );
  
  return uniqueWarnings;
}

// 用遞迴解析 Plan，產生 Mermaid 節點與連線
function parseExplainToMermaid(text, theme) { // Added theme parameter
  const lines = text.split('\n').filter(line => line.trim() !== '');
  const nodes = [];
  const edges = [];
  const styles = [];
  const nodeDetailsMap = {}; // Initialize nodeDetailsMap

  if (lines.length === 0) {
    return { nodes, edges, styles, nodeDetailsMap }; // Return nodeDetailsMap
  }

  let idCounter = 0;
  const nodeStack = []; // { id, indentation }
  const nodeInfos = {}; // id -> { details: [], totalCost: 0, children: [] }
  const costRegex = /cost=([\d.]+)\\..([\d.]+)/;

  lines.forEach(line => {
    const indentation = line.search(/\S|$/);
    const content = line.trim();
    const costMatch = content.match(costRegex);
    const totalCost = costMatch ? parseFloat(costMatch[2]) : 0;

    if (content.startsWith('->')) {
      const nodeText = content.replace(/^->\\s*/, '');
      const id = `node${idCounter++}`;
      
      while (nodeStack.length > 0 && nodeStack[nodeStack.length - 1].indentation >= indentation) {
        nodeStack.pop();
      }

      if (nodeStack.length > 0) {
        const parentId = nodeStack[nodeStack.length - 1].id;
        edges.push(`${parentId} --> ${id}`);
        if (nodeInfos[parentId]) {
          nodeInfos[parentId].children.push(id);
        }
      }

      nodeStack.push({ id, indentation });
      nodeInfos[id] = { details: [nodeText], totalCost, children: [] };
    } else if (nodeStack.length === 0) { // Root node
      const id = `node${idCounter++}`;
      nodeStack.push({ id, indentation });
      nodeInfos[id] = { details: [content], totalCost, children: [] };
    } else { // Additional info for the last node
      const lastNodeId = nodeStack[nodeStack.length - 1].id;
      if (nodeInfos[lastNodeId]) {
        nodeInfos[lastNodeId].details.push(content);
        // If the root node's cost is on a separate line
        if (nodeInfos[lastNodeId].totalCost === 0 && totalCost > 0) {
          nodeInfos[lastNodeId].totalCost = totalCost;
        }
      }
    }
  });

  // Calculate exclusive cost
  for (const id in nodeInfos) {
    const node = nodeInfos[id];
    const childrenTotalCost = node.children.reduce((sum, childId) => {
      return sum + (nodeInfos[childId]?.totalCost || 0);
    }, 0);
    node.exclusiveCost = node.totalCost - childrenTotalCost;
    // Handle floating point inaccuracies
    if (node.exclusiveCost < 0) {
        node.exclusiveCost = 0;
    }
  }

  const allExclusiveCosts = Object.values(nodeInfos).map(info => info.exclusiveCost).filter(c => c > 0);
  let highCostThreshold = 0;
  let mediumCostThreshold = 0;

  if (allExclusiveCosts.length > 0) {
    const sortedUniqueCosts = [...new Set(allExclusiveCosts)].sort((a, b) => b - a);
    const maxCost = sortedUniqueCosts[0] || 0;
    
    if (sortedUniqueCosts.length > 1) {
      const secondMaxCost = sortedUniqueCosts[1];
      // Set the "high cost" threshold just below the max cost
      highCostThreshold = (maxCost + secondMaxCost) / 2;
    } else {
      // If only one cost, anything above 0 is "high cost"
      highCostThreshold = 0.00001;
    }
    
    // Medium threshold remains a fraction of the absolute max cost
    mediumCostThreshold = maxCost * 0.33;
  }


  for (const id in nodeInfos) {
    const { details, exclusiveCost } = nodeInfos[id];
    const labelWithCost = [...details, `<b>Self Cost: ${exclusiveCost.toFixed(2)}</b>`];
    const label = labelWithCost.join('<br/>').replace(/"/g, '"');
    nodes.push(`${id}["${label}"]`);
    nodeDetailsMap[id] = { details: Array.isArray(details) ? details : [details], exclusiveCost }; // Ensure details is always an array

    if (exclusiveCost > 0) {
      let color;
      if (exclusiveCost >= highCostThreshold) {
        color = theme === 'dark' ? '#8B0000' : '#ffcccc'; // High cost - dark/light red
      } else if (exclusiveCost >= mediumCostThreshold) {
        color = theme === 'dark' ? '#BDB76B' : '#ffffcc'; // Medium cost - dark/light yellow
      } else {
        color = theme === 'dark' ? '#2E8B57' : '#ccffcc'; // Low cost - dark/light green
      }
      styles.push(`style ${id} fill:${color},stroke:#333,stroke-width:2px`);
    }
  }

  return { nodes, edges, styles, nodeDetailsMap }; // Return nodeDetailsMap
}


function DynamicMermaidFromXML() {
  const [xmlInput, setXmlInput] = useState(`XN Hash Join DS_BCAST_INNER  (cost=0.00..118.00 rows=1000 width=8)
  Hash Cond: (a.id = b.id)
  ->  XN Seq Scan on a  (cost=0.00..59.00 rows=1000 width=4)
  ->  XN Hash  (cost=0.00..59.00 rows=1000 width=4)
        ->  XN Seq Scan on b  (cost=0.00..59.00 rows=1000 width=4)`);
  const [xmlInput2, setXmlInput2] = useState('');
  
  const [mermaidCode, setMermaidCode] = useState("");
  const [warnings, setWarnings] = useState([]);
  const [theme, setTheme] = useState('light');
  const [selectedNode, setSelectedNode] = useState(null);
  const [nodeData, setNodeData] = useState({}); // To store node details for interactive display
  const containerRef = useRef(null);

  const lightTheme = {
    background: '#ffffff',
    text: '#000000',
    button: '#d32f2f',
    buttonText: '#ffffff',
    textarea: '#ffffff',
    diagramContainer: '#ffffff',
    warnings: {
      high: '#ffebee',
      medium: '#fff3e0',
      info: '#e3f2fd'
    }
  };

  const darkTheme = {
    background: '#121212',
    text: '#ffffff',
    button: '#d32f2f',
    buttonText: '#ffffff',
    textarea: '#333333',
    diagramContainer: '#333333',
    warnings: {
      high: '#4a148c',
      medium: '#e65100',
      info: '#01579b'
    }
  };

  const currentTheme = theme === 'light' ? lightTheme : darkTheme;

  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: theme === 'dark' ? 'dark' : 'default' });

    // Removed Firebase loading logic
  }, [theme]);


  function generateDiagram() {
    try {
      const { nodes, edges, styles, nodeDetailsMap } = parseExplainToMermaid(xmlInput, theme);
      const performanceWarnings = analyzePerformanceWarnings(nodeDetailsMap);
      
      setWarnings(performanceWarnings);
      setNodeData(nodeDetailsMap); // Store node details
      setSelectedNode(null); // Clear selected node on new diagram
      
      if (nodes.length === 0) {
        setMermaidCode("");
        if (containerRef.current) containerRef.current.innerHTML = "";
        return;
      }
      const mermaidStr = `graph TD\n${nodes.join("\n")}\n${edges.join("\n")}\n${styles.join("\n")}`;
      setMermaidCode(mermaidStr);
    } catch (e) {
      alert("Parse error: " + e.message);
      setMermaidCode("");
      setWarnings([]);
      if (containerRef.current) containerRef.current.innerHTML = "";
    }
  }

  useEffect(() => {
    const renderMermaid = async () => {
      if (!mermaidCode) {
        if (containerRef.current) {
          containerRef.current.innerHTML = "";
        }
        return;
      }

      try {
        const { svg } = await mermaid.render("diagram", mermaidCode);
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
          // Add click handlers to nodes
          const svgElement = containerRef.current.querySelector('svg');
          if (svgElement) {
            svgElement.querySelectorAll('.node').forEach(nodeElement => {
              const nodeId = nodeElement.id;
              nodeElement.addEventListener('click', () => {
                setSelectedNode(nodeData[nodeId]);
              });
            });
          }
        }
      } catch (e) {
        if (containerRef.current) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          containerRef.current.innerHTML = `<pre style="color:red;">${errorMessage}</pre>`;
        }
      }
    };

    renderMermaid();
  }, [mermaidCode, theme, nodeData]);

  function downloadSvg() {
    if (containerRef.current && containerRef.current.innerHTML) {
      const svgContent = containerRef.current.innerHTML;
      const blob = new Blob([svgContent], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "redshift-explain-plan.svg";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  // Removed saveExplainPlan function



  function normalizeNode(node) {
    // Create a unique key for a node based on its details (excluding dynamic costs)
    if (!node || !node.details) {
      return '';
    }
    
    // Ensure details is an array
    const detailsArray = Array.isArray(node.details) ? node.details : [node.details];
    return detailsArray.join('|').replace(/cost=[\d.]+\.\.[\d.]+/g, '');
  }

  function comparePlans() {
    if (!xmlInput || !xmlInput2) {
      alert("Please provide both Explain Plans for comparison.");
      return;
    }

    const { nodes: nodes1, edges: edges1, styles: styles1, nodeDetailsMap: nodeDetailsMap1 } = parseExplainToMermaid(xmlInput, theme);
    const { nodes: nodes2, edges: edges2, styles: styles2, nodeDetailsMap: nodeDetailsMap2 } = parseExplainToMermaid(xmlInput2, theme);

    const normalizedNodes1 = new Map();
    for (const nodeId in nodeDetailsMap1) {
      normalizedNodes1.set(normalizeNode(nodeDetailsMap1[nodeId]), nodeId);
    }

    const normalizedNodes2 = new Map();
    for (const nodeId in nodeDetailsMap2) {
      normalizedNodes2.set(normalizeNode(nodeDetailsMap2[nodeId]), nodeId);
    }

    const addedNodes = [];
    const removedNodes = [];
    const changedNodes = [];
    const unchangedNodes = [];

    // Identify added and changed nodes
    for (const normalizedKey2 of normalizedNodes2.keys()) {
      const nodeId2 = normalizedNodes2.get(normalizedKey2);
      const node2 = nodeDetailsMap2[nodeId2];

      if (normalizedNodes1.has(normalizedKey2)) {
        const nodeId1 = normalizedNodes1.get(normalizedKey2);
        const node1 = nodeDetailsMap1[nodeId1];
        // Check for changes in details (e.g., cost, rows)
        if (JSON.stringify(node1.details) !== JSON.stringify(node2.details) || node1.exclusiveCost !== node2.exclusiveCost) {
          changedNodes.push({ nodeId1, nodeId2, node1, node2 });
        } else {
          unchangedNodes.push({ nodeId1, nodeId2, node1, node2 });
        }
      } else {
        addedNodes.push({ nodeId: nodeId2, node: node2 });
      }
    }

    // Identify removed nodes
    for (const normalizedKey1 of normalizedNodes1.keys()) {
      if (!normalizedNodes2.has(normalizedKey1)) {
        const nodeId1 = normalizedNodes1.get(normalizedKey1);
        const node1 = nodeDetailsMap1[nodeId1];
        removedNodes.push({ nodeId: nodeId1, node: node1 });
      }
    }

    let combinedNodes = [];
    let combinedEdges = [];
    let combinedStyles = [];

    // Add nodes from plan 1 (removed and unchanged)
    for (const { nodeId, node } of removedNodes) {
      combinedNodes.push(`${nodeId}["Removed: ${node.details[0]}"]`);
      combinedStyles.push(`style ${nodeId} fill:#ffcccc,stroke:#f44336,stroke-width:2px`);
    }
    for (const { nodeId1, node1 } of unchangedNodes) {
      combinedNodes.push(`${nodeId1}["Unchanged: ${node1.details[0]}"]`);
      combinedStyles.push(`style ${nodeId1} fill:#ccffcc,stroke:#4CAF50,stroke-width:2px`);
    }

    // Add nodes from plan 2 (added and changed)
    for (const { nodeId, node } of addedNodes) {
      combinedNodes.push(`${nodeId}["Added: ${node.details[0]}"]`);
      combinedStyles.push(`style ${nodeId} fill:#cce0ff,stroke:#2196F3,stroke-width:2px`);
    }
    for (const { nodeId2, node2 } of changedNodes) {
      combinedNodes.push(`${nodeId2}["Changed: ${node2.details[0]}"]`);
      combinedStyles.push(`style ${nodeId2} fill:#ffffcc,stroke:#FFC107,stroke-width:2px`);
    }

    // Combine edges (simple union for now)
    combinedEdges = [...new Set([...edges1, ...edges2])];

    const combinedMermaidStr = `graph TD\n${combinedNodes.join("\n")}\n${combinedEdges.join("\n")}\n${combinedStyles.join("\n")}`;
    setMermaidCode(combinedMermaidStr);

    let summary = `Comparison Results:\n`;
    summary += `Added Nodes: ${addedNodes.length}\n`;
    summary += `Removed Nodes: ${removedNodes.length}\n`;
    summary += `Changed Nodes: ${changedNodes.length}\n`;
    summary += `Unchanged Nodes: ${unchangedNodes.length}\n`;
    alert(summary);
  }

  const highlightNode = (nodeId) => {
    clearHighlights();
    const svgElement = containerRef.current.querySelector('svg');
    if (svgElement) {
      const nodeElement = svgElement.querySelector(`#${nodeId}`);
      if (nodeElement) {
        nodeElement.classList.add('highlighted-node');
      }
    }
  };

  const clearHighlights = () => {
    const svgElement = containerRef.current.querySelector('svg');
    if (svgElement) {
      svgElement.querySelectorAll('.highlighted-node').forEach(nodeElement => {
        nodeElement.classList.remove('highlighted-node');
      });
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: 20, fontFamily: "Arial, sans-serif", textAlign: 'center', backgroundColor: currentTheme.background, color: currentTheme.text }}>
      <h2 style={{ color: currentTheme.button, marginBottom: '24px', fontSize: '2em' }}>Redshift Query Plan Visualizer</h2>
      <Editor
        value={xmlInput}
        onValueChange={setXmlInput}
        highlight={code => highlight(code, languages.sql, 'sql')}
        padding={10}
        style={{
          fontFamily: '"Fira code", "Fira Mono", monospace',
          fontSize: 14,
          width: '100%',
          boxSizing: 'border-box',
          marginBottom: 10,
          backgroundColor: currentTheme.textarea,
          color: currentTheme.text,
          border: '1px solid #ccc',
          minHeight: '200px',
          textAlign: 'left'
        }}
      />
      <h3 style={{ color: currentTheme.button, marginBottom: 10, marginTop: 20 }}>Second Explain Plan (for comparison)</h3>
      <Editor
        value={xmlInput2}
        onValueChange={setXmlInput2}
        highlight={code => highlight(code, languages.sql, 'sql')}
        padding={10}
        style={{
          fontFamily: '"Fira code", "Fira Mono", monospace',
          fontSize: 14,
          width: '100%',
          boxSizing: 'border-box',
          marginBottom: 10,
          backgroundColor: currentTheme.textarea,
          color: currentTheme.text,
          border: '1px solid #ccc',
          minHeight: '200px',
          textAlign: 'left'
        }}
      />
      <br />
      <button onClick={comparePlans} style={{ marginTop: 10, padding: "10px 20px", fontSize: '1em', cursor: 'pointer', backgroundColor: '#FF5722', color: 'white', border: 'none', borderRadius: 5 }}>
        Compare Plans
      </button>
      <br />
      <button onClick={generateDiagram} style={{ marginTop: 10, padding: "10px 20px", fontSize: '1em', cursor: 'pointer', backgroundColor: currentTheme.button, color: currentTheme.buttonText, border: 'none', borderRadius: 5 }}>
        Generate Diagram
      </button>
      <button onClick={downloadSvg} style={{ marginTop: 10, marginLeft: 10, padding: "10px 20px", fontSize: '1em', cursor: 'pointer', backgroundColor: '#1976d2', color: 'white', border: 'none', borderRadius: 5 }}>
        Export as SVG
      </button>
      {/* Removed Save Plan button */}
      {/* Removed Share URL display */}
      <div
        ref={containerRef}
        data-testid="diagram-container"
        style={{ marginTop: 20, border: "1px solid #ccc", padding: 10, minHeight: 200, backgroundColor: currentTheme.diagramContainer }}
      />
      
      {/* Performance Warnings Section */}
      {selectedNode && (
        <div style={{ marginTop: 20, textAlign: 'left', background: currentTheme.warnings.info, padding: 15, borderRadius: 5, borderLeft: '4px solid #0d47a1' }}>
          <h3 style={{ color: currentTheme.text, marginBottom: 10 }}>Selected Node Details</h3>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: currentTheme.text }}>
            {selectedNode.details}
            <br/>
            <strong>Self Cost: {selectedNode.exclusiveCost.toFixed(2)}</strong>
          </pre>
        </div>
      )}
      
      {/* Performance Warnings Section */}
      {warnings.length > 0 && (
        <div style={{ marginTop: 20, textAlign: 'left' }}>
          <h3 style={{ color: currentTheme.button, marginBottom: 10 }}>Performance Analysis</h3>
          <div style={{ background: currentTheme.background, padding: 15, borderRadius: 5 }}>
            {warnings.map((warning, index) => (
              <div 
                key={index} 
                style={{ 
                  marginBottom: 10, 
                  padding: 10, 
                  background: warning.severity === 'high' ? currentTheme.warnings.high : currentTheme.warnings.medium,
                  borderLeft: `4px solid ${warning.severity === 'high' ? '#f44336' : '#ff9800'}`, 
                  borderRadius: 3,
                  cursor: 'pointer'
                }}
                onClick={() => {
                  if (warning.nodeId) {
                    highlightNode(warning.nodeId);
                    setSelectedNode(nodeData[warning.nodeId]);
                  }
                }}
              >
                <div style={{ fontWeight: 'bold', marginBottom: 5 }}>
                  {warning.type === 'warning' ? '⚠️ Warning' : 'ℹ️ Info'}
                </div>
                <div>{renderMessageWithLinks(warning.message)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default DynamicMermaidFromXML;
