from pathlib import Path

from artifact_evaluator import build_evaluation_profile, evaluate_gomoku


def test_gomoku_task_builds_specialized_contract() -> None:
    profile = build_evaluation_profile("请制作一个网页版五子棋游戏")
    assert profile["id"] == "gomoku-web-v1"
    assert len(profile["acceptance_criteria"]) == 8


def test_incomplete_gomoku_is_reported(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<h1>五子棋</h1><div id='board'>15 x 15</div>", encoding="utf-8")

    result = evaluate_gomoku(tmp_path)

    assert result["status"] == "INCOMPLETE"
    assert result["score"] < result["threshold"]
    assert "四方向胜负判断" in result["failed_capabilities"]


def test_complete_contract_signals_pass(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text(
        "<canvas id='board'></canvas><button id='restart'>重新开始</button><script src='game.js'></script>",
        encoding="utf-8",
    )
    (tmp_path / "styles.css").write_text(
        "#board{width:min(92vw,600px)}@media(max-width:600px){#board{width:96vw}}",
        encoding="utf-8",
    )
    (tmp_path / "game.js").write_text(
        """const size=15;
const board=Array.from({length:size},()=>Array(size).fill(null));
let currentPlayer='black',gameOver=false;
const directions=[[1,0],[0,1],[1,1],[1,-1]];
document.querySelector('#board').addEventListener('click',()=>{
 const row=0,col=0;if(gameOver||board[row][col]!==null)return;
 board[row][col]=currentPlayer;currentPlayer=currentPlayer==='black'?'white':'black';
});
document.querySelector('#restart').addEventListener('click',function reset(){gameOver=false;});
function winner(){return directions.some(()=>false);}
""",
        encoding="utf-8",
    )

    result = evaluate_gomoku(tmp_path)

    assert result["status"] == "PASS"
    assert result["score"] == 100
    assert result["preview_entry"] == "index.html"
