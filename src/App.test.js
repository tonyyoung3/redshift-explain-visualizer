import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import App from './App';

// Mock mermaid to avoid errors in test environment
jest.mock('mermaid', () => ({
  initialize: jest.fn(),
  render: jest.fn().mockResolvedValue({ svg: '<svg>mocked svg</svg>' }),
}));

describe('App component', () => {
  test('renders the main title', () => {
    render(<App />);
    const titleElement = screen.getByText(/Redshift Explain Converter/i);
    expect(titleElement).toBeInTheDocument();
  });

  test('renders the textarea with default value', () => {
    render(<App />);
    const textareaElement = screen.getByRole('textbox');
    expect(textareaElement).toBeInTheDocument();
    expect(textareaElement.value).toContain('XN Hash Join DS_BCAST_INNER');
  });

  test('clicking "Generate Diagram" button triggers diagram generation', async () => {
    render(<App />);
    const buttonElement = screen.getByText(/Generate Diagram/i);
    fireEvent.click(buttonElement);

    const diagramContainer = screen.getByTestId('diagram-container');

    await waitFor(() => {
      expect(diagramContainer).not.toBeEmptyDOMElement();
    });
  });
});
