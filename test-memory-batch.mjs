const response =
  await fetch(
    "http://localhost:3000/api/memory/ingest-batch-test",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify({
          email:
            "Aki.Vivekanandan@suffolk.edu",

          limit:
            6,
        }),
    }
  );

const result =
  await response.json();

console.dir(
  result,
  {
    depth: null,
  }
);