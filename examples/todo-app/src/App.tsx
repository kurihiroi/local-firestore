import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  updateDoc,
  where,
} from "@local-firestore/client";
import { useCallback, useEffect, useState } from "react";
import { FiCheck, FiPlus, FiTrash2 } from "react-icons/fi";

interface Todo {
  title: string;
  completed: boolean;
  createdAt: number;
}

const db = getFirestore({ host: "localhost", port: 8080 });
const todosRef = collection(db, "todos");

type FilterType = "all" | "active" | "completed";

function App() {
  const [todos, setTodos] = useState<{ id: string; data: Todo }[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [loading, setLoading] = useState(true);

  const fetchTodos = useCallback(async () => {
    const constraints = [orderBy("createdAt", "desc")];
    if (filter === "active") {
      constraints.push(where("completed", "==", false));
    } else if (filter === "completed") {
      constraints.push(where("completed", "==", true));
    }

    const q = query(todosRef, ...constraints);
    const snapshot = await getDocs(q);
    setTodos(
      snapshot.docs.map((d) => ({
        id: d.id,
        data: d.data() as unknown as Todo,
      })),
    );
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);

  const handleAdd = async () => {
    const title = newTitle.trim();
    if (!title) return;

    await addDoc(todosRef, {
      title,
      completed: false,
      createdAt: Date.now(),
    });
    setNewTitle("");
    await fetchTodos();
  };

  const handleToggle = async (id: string, currentCompleted: boolean) => {
    const ref = doc(db, "todos", id);
    await updateDoc(ref, { completed: !currentCompleted });
    await fetchTodos();
  };

  const handleDelete = async (id: string) => {
    const ref = doc(db, "todos", id);
    await deleteDoc(ref);
    await fetchTodos();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleAdd();
    }
  };

  const activeCount = todos.filter((t) => !t.data.completed).length;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-lg px-4 py-12">
        <h1 className="mb-8 text-center text-3xl font-bold text-gray-800">Todo App</h1>
        <p className="mb-6 text-center text-sm text-gray-500">
          Powered by <span className="font-semibold text-indigo-600">local-firestore</span>
        </p>

        {/* 入力フォーム */}
        <div className="mb-6 flex gap-2">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="What needs to be done?"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 text-gray-700 shadow-sm transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newTitle.trim()}
            className="rounded-lg bg-indigo-600 px-4 py-3 text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FiPlus size={20} />
          </button>
        </div>

        {/* フィルタ */}
        <div className="mb-4 flex justify-center gap-1">
          {(["all", "active", "completed"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1 text-sm capitalize transition ${
                filter === f ? "bg-indigo-600 text-white" : "text-gray-600 hover:bg-gray-200"
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Todo リスト */}
        {loading ? (
          <p className="py-8 text-center text-gray-400">Loading...</p>
        ) : todos.length === 0 ? (
          <p className="py-8 text-center text-gray-400">
            {filter === "all" ? "No todos yet. Add one!" : `No ${filter} todos.`}
          </p>
        ) : (
          <ul className="space-y-2">
            {todos.map((todo) => (
              <li
                key={todo.id}
                className="flex items-center gap-3 rounded-lg bg-white px-4 py-3 shadow-sm transition hover:shadow-md"
              >
                <button
                  type="button"
                  onClick={() => handleToggle(todo.id, todo.data.completed)}
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition ${
                    todo.data.completed
                      ? "border-green-500 bg-green-500 text-white"
                      : "border-gray-300 hover:border-indigo-400"
                  }`}
                >
                  {todo.data.completed && <FiCheck size={14} />}
                </button>
                <span
                  className={`flex-1 ${
                    todo.data.completed ? "text-gray-400 line-through" : "text-gray-700"
                  }`}
                >
                  {todo.data.title}
                </span>
                <button
                  type="button"
                  onClick={() => handleDelete(todo.id)}
                  className="rounded p-1 text-gray-400 transition hover:bg-red-50 hover:text-red-500"
                >
                  <FiTrash2 size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* フッター */}
        <p className="mt-4 text-center text-sm text-gray-400">
          {activeCount} item{activeCount !== 1 ? "s" : ""} left
        </p>
      </div>
    </div>
  );
}

export default App;
