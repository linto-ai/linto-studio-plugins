import 'milligram/dist/milligram.min.css'
import 'tui-pagination/dist/tui-pagination.min.css'
import './css/style.css'

import UserSessionController from './src/userSessionController.js'


window.addEventListener('load', (event) => {
    const sessionController = new UserSessionController()
});
