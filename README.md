# Redshift Query Plan Visualizer

This is a web-based tool to visualize and analyze the output of a Redshift `EXPLAIN` query. It helps you understand the query execution plan and identify potential performance bottlenecks.

## How to Use

1.  Paste the text output of your Redshift `EXPLAIN` query into the text box.
2.  Click the "Generate Diagram" button.
3.  The tool will generate a flowchart diagram of the query plan.
4.  It will also analyze the plan for common performance issues and display any warnings it finds.

## Features

*   **Visualization:** Generates a Mermaid.js flowchart to visualize the query plan.
*   **Performance Analysis:** Detects common performance issues such as:
    *   Nested Loop joins
    *   Large sequential scans
    *   Data broadcasting
    *   Expensive Hash operations

## Getting Started

To run the application locally:

1.  Clone the repository.
2.  Install the dependencies:
    ```bash
    npm install
    ```
3.  Start the development server:
    ```bash
    npm start
    ```
4.  Open [http://localhost:3000](http://localhost:3000) to view it in your browser.
