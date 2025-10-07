# TurboCat - Apache Tomcat Extension for VS Code

**Streamlined Apache Tomcat Development for Visual Studio Code**

[![Version](https://img.shields.io/visual-studio-marketplace/v/Awei.turbocat)](https://marketplace.visualstudio.com/items?itemName=Awei.turbocat)
[![Downloads](https://img.shields.io/visual-studio-marketplace/d/Awei.turbocat)](https://marketplace.visualstudio.com/items?itemName=Awei.turbocat)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/Awei.turbocat)](https://marketplace.visualstudio.com/items?itemName=Awei.turbocat)

## Overview

TurboCat simplifies Java web development by providing seamless Apache Tomcat integration directly within Visual Studio Code. Deploy and test your Java web applications with just a few clicks.

## Key Features

### Server Management
- Start and stop Tomcat servers instantly
- Automatic configuration detection
- Debug mode support
- Real-time server status monitoring

### Smart Deployment
- One-click application deployment
- Automatic deployment on file save
- Multiple build strategies (Maven, Gradle)
- Fast deployment for quick testing

### Browser Integration
- Automatic browser launch
- Support for Chrome, Firefox, Edge, and Safari
- Live page refresh after deployment
- Cross-platform compatibility

### Developer Experience
- Clear error messages and logging
- Visual status indicators
- Command palette integration
- Configurable settings

## Getting Started

### Installation

1. Open Visual Studio Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "TurboCat"
4. Click Install

### Basic Setup

1. Open your Java web project in VS Code
2. Ensure Apache Tomcat is installed on your system
3. Configure Tomcat path in settings if needed
4. Start using TurboCat commands

## Usage

### Quick Commands

Open the Command Palette (Ctrl+Shift+P) and use:

- **Start Tomcat** - Launch your Tomcat server
- **Deploy Project** - Deploy your application to Tomcat
- **Stop Tomcat** - Stop the running server
- **Open in Browser** - View your application
- **Clean Tomcat** - Clean deployment directory

### Status Bar

TurboCat adds helpful buttons to your VS Code status bar for quick access to common actions.

## Configuration

Access settings through File > Preferences > Settings, then search for "TurboCat":

### Basic Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Tomcat Home | Path to your Tomcat installation | Auto-detected |
| Server Port | Port number for Tomcat server | 8080 |
| Browser | Preferred browser for testing | Chrome |
| Auto Deploy | Automatically deploy on file save | Enabled |

### Example Configuration

```json
{
  "turbocat.tomcatHome": "C:\\apache-tomcat-9.0.65",
  "turbocat.port": 8080,
  "turbocat.browser": "chrome",
  "turbocat.autoDeploy": "Enable"
}
```

## Supported Projects

TurboCat works with:
- Maven web projects
- Gradle web projects
- Standard Java EE applications
- JSP and Servlet applications

## System Requirements

- Visual Studio Code 1.56.0 or newer
- Apache Tomcat 8.5 or newer
- Java Development Kit (JDK) 8 or newer
- Maven or Gradle (for build automation)

## Troubleshooting

### Common Issues

**Server won't start**
- Check that Tomcat is properly installed
- Verify the Tomcat Home path in settings
- Ensure port 8080 is available

**Deployment fails**
- Confirm your project structure is correct
- Check that Maven or Gradle is installed
- Verify Java is properly configured

**Browser doesn't open**
- Check browser selection in settings
- Ensure the application deployed successfully
- Verify the server is running

### Getting Help

If you encounter issues:
1. Check the Output panel in VS Code for error messages
2. Review your project structure and configuration
3. Consult the troubleshooting section above
4. Submit an issue on our GitHub repository

## Support

For questions, bug reports, or feature requests:
- GitHub Issues: [Report an Issue](https://github.com/Al-rimi/turbocat/issues)
- Email Support: awei@sumaho.live

## License

This extension is licensed under the MIT License. See the LICENSE file for details.

---

**About the Developer**

TurboCat is developed and maintained by Awei. Visit [sumaho.live](https://www.sumaho.live) for more information about our development tools and