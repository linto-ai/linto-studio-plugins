import 'milligram/dist/milligram.min.css'
import 'tui-pagination/dist/tui-pagination.min.css'
import './css/style.css'

import SessionController from './src/sessionController.js'


window.addEventListener('load', (event) => {
    const sessionController = new SessionController()
});